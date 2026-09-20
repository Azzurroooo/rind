"""Single service for provider definitions, credentials and model clients."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
from pathlib import Path
import tempfile
from typing import Any

import openai

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
from agent.infrastructure.llm.cancellation import close_resource
from agent.infrastructure.llm.catalog import PROVIDERS, default_reasoning_efforts, refreshable_models_api
from agent.infrastructure.settings import AppSettings, load_settings


logger = logging.getLogger(__name__)
MODEL_CACHE_TTL = 24 * 60 * 60
MODEL_LIST_TIMEOUT = 10


def build_async_client(api_key: str, base_url: str, *, max_retries: int = 2) -> openai.AsyncOpenAI:
    from agent.infrastructure.settings import DEFAULT_USER_AGENT

    return openai.AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        max_retries=max_retries,
        default_headers={"User-Agent": DEFAULT_USER_AGENT},
    )


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

    async def refresh_stale_models(self, workspace_root: str | None = None) -> None:
        """Refresh each configured provider once; ordinary reads remain offline."""
        try:
            settings = load_settings(workspace_root)
            cache = self._read_cache()
            for definition in self.providers.values():
                if not refreshable_models_api(_effective_api(settings, definition)):
                    continue
                if self._resolve_credential(settings, definition.id) is None:
                    continue
                entry = cache.get(definition.id)
                if isinstance(entry, dict) and entry.get("base_url") == self._endpoint(settings, definition):
                    refreshed_at = entry.get("refreshed_at")
                    if (
                        self._cached_models(entry, settings, definition)
                        and type(refreshed_at) in (int, float)
                        and math.isfinite(refreshed_at)
                        and 0 <= time.time() - refreshed_at < MODEL_CACHE_TTL
                    ):
                        continue
                await self._fetch_models(settings, definition)
        except Exception as exc:
            logger.debug("Background model refresh failed (%s)", type(exc).__name__)

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

            return OpenAIChatCompletionsClient(
                build_async_client(key, endpoint, max_retries=14), selection.model_id, selection.reasoning_effort,
                workspace_root=workspace_root, reasoning_efforts=efforts,
            )
        if definition.api == "openai-responses":
            from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient

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
                for item in self._cached_models(cache.get(definition.id), settings, definition)
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
        if not refreshable_models_api(_effective_api(settings, definition)):
            return True
        credential = self._resolve_credential(settings, definition.id)
        if credential is None:
            return False

        client = None
        try:
            endpoint = self._endpoint(settings, definition)
            client = build_async_client(credential.key or credential.access, endpoint, max_retries=0)
            async with asyncio.timeout(MODEL_LIST_TIMEOUT):
                response = await client.models.list(timeout=MODEL_LIST_TIMEOUT)
                data = getattr(response, "data", response)
                if hasattr(data, "__aiter__"):
                    data = [item async for item in data]
                if not isinstance(data, (list, tuple)):
                    raise ValueError("Invalid model list")
                if any(not isinstance(item.get("id") if isinstance(item, dict) else getattr(item, "id", None), str)
                       for item in data):
                    raise ValueError("Invalid model identifier")
                models = [{"id": _item_id(item), "name": _item_id(item)} for item in data]
                if any(not item["id"] for item in models):
                    raise ValueError("Invalid model identifier")
            if not models:
                logger.debug("Model refresh returned an empty list for %s", definition.id)
                return False
            self._write_cache(self._read_cache() | {definition.id: {
                "models": models, "refreshed_at": time.time(), "base_url": endpoint,
            }})
            return True
        except Exception as exc:
            logger.debug("Model refresh failed for %s (%s)", definition.id, type(exc).__name__)
            return False
        finally:
            if client is not None:
                try:
                    await close_resource(client)
                except Exception as exc:
                    logger.debug("Model client cleanup failed (%s)", type(exc).__name__)

    def _cached_models(self, entry: Any, settings: AppSettings, definition) -> list:
        # Legacy lists have no known endpoint or success time; read them until refreshed.
        if isinstance(entry, dict):
            if entry.get("base_url") != self._endpoint(settings, definition):
                return []
            entry = entry.get("models")
        return [item for item in entry if _item_id(item)] if isinstance(entry, list) else []

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

    def _read_cache(self) -> dict[str, Any]:
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
