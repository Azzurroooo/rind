"""Single service for provider definitions, credentials and model clients."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from agent.domain.errors import ProviderError
from agent.domain.models import (
    Credential,
    ModelCatalog,
    ModelDefinition,
    ModelSelection,
    ModelStreamEvent,
    ProviderStatus,
)
from agent.infrastructure.credentials import CredentialStore
from agent.infrastructure.settings import AppSettings, load_settings

from agent.infrastructure.llm.cancellation import close_resource
from agent.infrastructure.llm.catalog import PROVIDERS, default_reasoning_efforts, refreshable_models_api


class ProviderServiceImpl:
    def __init__(self, credential_store: CredentialStore | None = None, providers=None) -> None:
        self.credentials = credential_store or CredentialStore()
        self.providers = dict(providers or PROVIDERS)
        self.cache_path = self.credentials.path.with_name("model-cache.json")

    def default_selection(self, workspace_root: str | None = None) -> ModelSelection:
        settings = load_settings(workspace_root)
        return ModelSelection(settings.provider, settings.model, settings.reasoning_effort)

    def resolve_selection(self, workspace_root: str | None, selection: ModelSelection) -> ModelDefinition:
        definition = self._provider(selection.provider_id)
        return _selection_model(load_settings(workspace_root), definition, selection)

    def list_providers(self, workspace_root: str | None = None) -> list[ProviderStatus]:
        try:
            settings: AppSettings | None = load_settings(workspace_root)
        except (OSError, ValueError):
            settings = None
        result = []
        for definition in self.providers.values():
            source = self._credential_source(settings, definition.id)
            result.append(ProviderStatus(definition.id, definition.name, definition.auth_methods, source != "none", source))
        return result

    async def list_models(self, workspace_root: str | None = None, *, refresh: bool = False) -> ModelCatalog:
        settings = load_settings(workspace_root)
        failures: list[str] = []
        for definition in self.providers.values():
            if self._credential_source(settings, definition.id) == "none":
                continue
            if refresh and not await self._fetch_models(settings, definition):
                failures.append(f"failed to refresh {definition.name} models, showing saved models")
        models = self._catalog(settings)
        return ModelCatalog(models, "; ".join(failures) or None)

    async def login(self, workspace_root: str | None, provider_id: str, method: str, interaction) -> None:
        definition = self._provider(provider_id)
        if method not in definition.auth_methods:
            raise ValueError(f"{definition.name} does not support {method} login.")
        if method != "api_key":
            raise ValueError(f"{method} login is not implemented.")
        key = (await interaction.prompt("secret", f"{definition.name} API key")).strip()
        if not key:
            raise ValueError("Login canceled.")
        self.credentials.set(provider_id, Credential(type="api_key", key=key))
        await self._fetch_models(load_settings(workspace_root), definition)

    def logout(self, provider_id: str) -> bool:
        return self.credentials.delete(provider_id)

    async def create_chat_client(self, settings: AppSettings, selection: ModelSelection, *, workspace_root: str | None):
        definition = self._provider(selection.provider_id)
        credential = self._resolve_credential(settings, definition.id)
        if credential is None:
            raise ProviderError(
                f"{definition.name} is not configured. Run /login or set {definition.environment_key}.",
                status="rejected", code="provider_not_configured",
            )
        endpoint = self._endpoint(settings, definition)
        key = credential.key or credential.access
        efforts = next((model.reasoning_efforts for model in definition.fallback_models if model.id == selection.model_id), ())
        if definition.api == "openai-chat":
            from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
            from agent.infrastructure.llm.openai_chat_client import build_async_client

            return OpenAIChatCompletionsClient(
                build_async_client(key, endpoint, max_retries=14), selection.model_id, selection.reasoning_effort,
                workspace_root=workspace_root, reasoning_efforts=efforts,
            )
        if definition.api == "openai-responses":
            from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient
            from agent.infrastructure.llm.openai_chat_client import build_async_client

            return OpenAIResponsesClient(
                build_async_client(key, endpoint), selection.model_id, selection.reasoning_effort,
                workspace_root=workspace_root, reasoning_efforts=efforts,
            )
        if definition.api == "anthropic-messages":
            from agent.infrastructure.llm.anthropic_messages import AnthropicMessagesClient

            return AnthropicMessagesClient(api_key=key, model=selection.model_id, base_url=endpoint)
        if definition.api == "google-generative-ai":
            from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient

            return GoogleGenerativeAIClient(api_key=key, model=selection.model_id, base_url=endpoint)
        raise ProviderError(f"Unsupported provider API: {definition.api}", status="rejected", code="unsupported_api")

    @staticmethod
    def unavailable_client(selection: ModelSelection, message: str):
        return _UnavailableChatClient(selection.model_id, message)

    def _catalog(self, settings: AppSettings) -> list[ModelDefinition]:
        cache = self._read_cache()
        result: list[ModelDefinition] = []
        for definition in self.providers.values():
            if self._credential_source(settings, definition.id) == "none":
                continue
            api = _effective_api(settings, definition)
            verified = {model.id: model.reasoning_efforts for model in definition.fallback_models}
            models = [
                _model(definition, api, item, verified.get(_item_id(item)))
                for item in cache.get(definition.id) or ()
            ] or list(definition.fallback_models)
            result.extend(models)
        current = ModelSelection(settings.provider, settings.model)
        definition = self.providers.get(current.provider_id)
        if definition is not None and not any(
            model.provider_id == current.provider_id and model.id == current.model_id for model in result
        ):
            result.append(_selection_model(settings, definition, current))
        return result

    async def _fetch_models(self, settings: AppSettings, definition) -> bool:
        if not refreshable_models_api(definition.api):
            return True
        credential = self._resolve_credential(settings, definition.id)
        if credential is None:
            return False
        from agent.infrastructure.llm.openai_chat_client import build_async_client

        client = build_async_client(credential.key or credential.access, self._endpoint(settings, definition))
        try:
            response = await client.models.list()
            data = getattr(response, "data", response)
            if hasattr(data, "__aiter__"):
                data = [item async for item in data]
            models = [{"id": _item_id(item), "name": _item_id(item)} for item in data or []]
            models = [item for item in models if item["id"]]
            if not models:
                return False
            self._write_cache(self._read_cache() | {definition.id: models})
            return True
        except Exception:
            return False
        finally:
            await close_resource(client)

    def _provider(self, provider_id: str):
        try:
            return self.providers[provider_id]
        except KeyError:
            return self.providers["openai-compatible"]

    def _credential_source(self, settings: AppSettings | None, provider_id: str) -> str:
        if settings is not None and settings.provider == provider_id and settings.api_key:
            return "workspace"
        if self.credentials.get(provider_id) is not None:
            return "stored"
        env_name = self._provider(provider_id).environment_key
        return "environment" if env_name and os.getenv(env_name, "").strip() else "none"

    def _resolve_credential(self, settings: AppSettings, provider_id: str) -> Credential | None:
        if settings.provider == provider_id and settings.api_key:
            value = settings.api_key
            if value.startswith("$"):
                value = os.getenv(value[1:], "")
            if value:
                return Credential(type="api_key", key=value)
        stored = self.credentials.get(provider_id)
        if stored is not None:
            return stored
        env_name = self._provider(provider_id).environment_key
        value = os.getenv(env_name, "").strip() if env_name else ""
        return Credential(type="api_key", key=value) if value else None

    @staticmethod
    def _endpoint(settings: AppSettings, definition) -> str:
        configured = str(settings.base_url or "").strip()
        if settings.provider == definition.id and configured:
            return configured
        return definition.default_base_url

    def _read_cache(self) -> dict[str, list[dict[str, Any]]]:
        if not self.cache_path.exists():
            return {}
        try:
            value = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _write_cache(self, data: dict[str, Any]) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.cache_path.name}.", dir=self.cache_path.parent)
        temporary = Path(temporary_name)
        try:
            os.close(fd)
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, self.cache_path)
        finally:
            temporary.unlink(missing_ok=True)


class _UnavailableChatClient:
    def __init__(self, model: str, message: str) -> None:
        self.model = model
        self.message = message

    async def create(self, *args, **kwargs):
        raise ProviderError(self.message, status="rejected", code="provider_not_configured")

    async def stream(self, *args, **kwargs):
        raise ProviderError(self.message, status="rejected", code="provider_not_configured")
        yield  # unreachable; keeps stream an async iterator so turns see the ProviderError

    async def close(self) -> None:
        return None


def _effective_api(settings: AppSettings, definition) -> str:
    return settings.api if definition.id == "openai-compatible" else definition.api


def _model(definition, api: str, item: Any, efforts: tuple[str, ...] | None = None) -> ModelDefinition:
    model_id = _item_id(item)
    name = str(item.get("name") or model_id) if isinstance(item, dict) else model_id
    return ModelDefinition(definition.id, model_id, name, api, default_reasoning_efforts(api) if efforts is None else efforts)


def _selection_model(settings: AppSettings, definition, selection: ModelSelection) -> ModelDefinition:
    for model in definition.fallback_models:
        if model.id == selection.model_id:
            return model
    api = _effective_api(settings, definition)
    return ModelDefinition(definition.id, selection.model_id, selection.model_id, api, default_reasoning_efforts(api))


def _item_id(item: Any) -> str:
    return str(item.get("id") or "").strip() if isinstance(item, dict) else str(getattr(item, "id", "") or "").strip()
