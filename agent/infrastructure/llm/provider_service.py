"""Single service for provider definitions, credentials and model clients."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from agent.domain.errors import ProviderError
from agent.domain.models import Credential, ModelDefinition, ModelSelection, ProviderStatus, ModelStreamEvent
from agent.infrastructure.auth import CredentialStore
from agent.infrastructure.config.settings_loader import AppSettings, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_USER_AGENT, load_settings

from .providers import PROVIDERS, provider


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
        for model in definition.fallback_models:
            if model.id == selection.model_id:
                return model
        settings = load_settings(workspace_root)
        api = settings.api if selection.provider_id == "openai-compatible" else definition.api
        return ModelDefinition(selection.provider_id, selection.model_id, selection.model_id, api)

    def list_providers(self, workspace_root: str | None = None) -> list[ProviderStatus]:
        try:
            settings = load_settings(workspace_root)
        except (OSError, ValueError):
            settings = AppSettings(Path("settings.json"), False, DEFAULT_MODEL, "", DEFAULT_BASE_URL, "", DEFAULT_USER_AGENT, provider="openai")
        result = []
        for definition in self.providers.values():
            source = self._credential_source(settings, definition.id)
            result.append(ProviderStatus(definition.id, definition.name, definition.auth_methods, source != "none", source))
        return result

    async def list_models(self, workspace_root: str | None = None, *, refresh: bool = False) -> list[ModelDefinition]:
        settings = load_settings(workspace_root)
        cache = self._read_cache()
        result: list[ModelDefinition] = []
        for definition in self.providers.values():
            if self._credential_source(settings, definition.id) == "none":
                continue
            values = cache.get(definition.id)
            if refresh and definition.api in {"openai-chat", "openai-responses"}:
                refreshed = await self._refresh_models(settings, definition)
                if refreshed is not None:
                    values = refreshed
                    cache[definition.id] = refreshed
            models = [self._model_from_cache(definition.id, definition.api, item) for item in values or ()]
            if not models:
                models = list(definition.fallback_models)
            result.extend(models)
        current = self.default_selection(workspace_root)
        if current.provider_id in self.providers and not any(m.provider_id == current.provider_id and m.id == current.model_id for m in result):
            result.append(self.resolve_selection(workspace_root, current))
        return result

    async def _refresh_models(self, settings: AppSettings, definition) -> list[dict[str, str]] | None:
        credential = self._resolve_credential(settings, definition.id)
        if credential is None:
            return None
        endpoint = self._endpoint(settings, definition)
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=credential.key or credential.access, base_url=endpoint)
            response = client.models.list()
            if hasattr(response, "__await__"):
                response = await response
            data = getattr(response, "data", response)
            if hasattr(data, "__aiter__"):
                data = [item async for item in data]
            models = [{"id": _item_id(item), "name": _item_id(item)} for item in (data or [])]
            models = [item for item in models if item["id"]]
            if models:
                self._write_cache(self._read_cache() | {definition.id: models})
            close = getattr(client, "close", None)
            if callable(close):
                value = close()
                if hasattr(value, "__await__"):
                    await value
            return models or None
        except Exception:
            return None

    async def create_chat_client(self, workspace_root: str | None, selection: ModelSelection):
        settings = load_settings(workspace_root)
        definition = self.resolve_selection(workspace_root, selection)
        credential = self._resolve_credential(settings, definition.id)
        if credential is None:
            raise ProviderError(
                f"{self._provider(definition.provider_id).name} is not configured. Run /login or set {self._provider(definition.provider_id).environment_key}.",
                status="rejected", code="provider_not_configured",
            )
        endpoint = self._endpoint(settings, self._provider(definition.provider_id))
        key = credential.key or credential.access
        if definition.api == "openai-chat":
            from .openai_chat import OpenAIChatCompletionsClient
            from openai import AsyncOpenAI
            return OpenAIChatCompletionsClient(AsyncOpenAI(api_key=key, base_url=endpoint), selection.model_id, selection.reasoning_effort, workspace_root=workspace_root)
        if definition.api == "openai-responses":
            from .openai_responses import OpenAIResponsesClient
            from openai import AsyncOpenAI
            return OpenAIResponsesClient(AsyncOpenAI(api_key=key, base_url=endpoint), selection.model_id, selection.reasoning_effort, workspace_root=workspace_root)
        if definition.api == "anthropic-messages":
            from .anthropic_messages import AnthropicMessagesClient
            return AnthropicMessagesClient(api_key=key, model=selection.model_id, reasoning_effort=selection.reasoning_effort, base_url=endpoint)
            raise ProviderError(f"Unsupported provider API: {definition.api}", status="rejected", code="unsupported_api")

    @staticmethod
    def unavailable_client(selection: ModelSelection, message: str):
        return _UnavailableChatClient(selection.model_id, message)

    async def login(self, workspace_root: str | None, provider_id: str, method: str, interaction) -> None:
        definition = self._provider(provider_id)
        if method not in definition.auth_methods:
            raise ValueError(f"{definition.name} does not support {method} login.")
        if method != "api_key":
            raise ValueError(f"{method} login is not implemented.")
        key = (await interaction.prompt("secret", f"{definition.name} API key")).strip()
        if not key:
            raise ValueError("API key is required.")
        self.credentials.set(provider_id, Credential(type="api_key", key=key))

    def logout(self, provider_id: str) -> None:
        self.credentials.delete(provider_id)

    def _provider(self, provider_id: str):
        try:
            return self.providers[provider_id]
        except KeyError:
            return self.providers["openai-compatible"]

    def _credential_source(self, settings: AppSettings, provider_id: str) -> str:
        explicit = settings.api_key if settings.provider == provider_id else ""
        if explicit:
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
        if definition.id != "openai-compatible" and configured in {"", DEFAULT_BASE_URL}:
            return definition.default_base_url
        return configured or definition.default_base_url

    def _read_cache(self) -> dict[str, list[dict[str, Any]]]:
        if not self.cache_path.exists():
            return {}

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
        try:
            value = json.loads(self.cache_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    @staticmethod
    def _model_from_cache(provider_id: str, api: str, item: Any) -> ModelDefinition:
        if isinstance(item, str):
            return ModelDefinition(provider_id, item, item, api)
        return ModelDefinition(provider_id, str(item.get("id") or ""), str(item.get("name") or item.get("id") or ""), api)


class _UnavailableChatClient:
    def __init__(self, model: str, message: str) -> None:
        self.model = model
        self.message = message

    async def create(self, *args, **kwargs):
        raise ProviderError(self.message, status="rejected", code="provider_not_configured")

    async def stream(self, *args, **kwargs):
        raise ProviderError(self.message, status="rejected", code="provider_not_configured")
        yield ModelStreamEvent("completed", stop_reason="error")

    async def close(self) -> None:
        return None


def _item_id(item: Any) -> str:
    return str(item.get("id") or "").strip() if isinstance(item, dict) else str(getattr(item, "id", "") or "").strip()
