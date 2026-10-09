"""Single service for connections, credentials and model clients.

A connection is what a selection names: a built-in provider (its id is the
provider id) or a named endpoint the user added with /login. Sessions store the
connection id; its endpoint and key are resolved again at every client build.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import time
from dataclasses import replace
from pathlib import Path
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

import openai

from agent.domain.errors import ProviderError
from agent.domain.models import (
    Credential,
    ModelCatalog,
    ModelDefinition,
    ModelSelection,
    ProviderDefinition,
    ProviderStatus,
)
from agent.infrastructure.credentials import CredentialStore
import agent.infrastructure.llm.chatgpt_oauth as chatgpt_oauth
from agent.infrastructure.llm.cancellation import close_resource
from agent.infrastructure.llm.catalog import PROVIDERS, default_reasoning_efforts, refreshable_models_api
from agent.infrastructure.settings import AppSettings, load_settings


logger = logging.getLogger(__name__)
MODEL_CACHE_TTL = 24 * 60 * 60
MODEL_LIST_TIMEOUT = 10
CONNECTION_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
# Providers that sign in with an account; each flow offers login(interaction),
# expiring(credential) and fresh(credential).
OAUTH_FLOWS = {"openai": chatgpt_oauth}


# A key, or for a signed-in account a provider of its current access token.
ApiKey = str | Callable[[], Awaitable[str]]


def build_async_client(api_key: ApiKey, base_url: str, *, max_retries: int = 2) -> openai.AsyncOpenAI:
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

    def default_selection(self) -> ModelSelection:
        settings = load_settings()
        return ModelSelection(settings.provider, settings.model, settings.reasoning_effort)

    def resolve_selection(self, selection: ModelSelection, *, settings: AppSettings | None = None) -> ModelDefinition:
        definition = self._provider(selection.provider_id)
        settings = settings if settings is not None else load_settings()
        return self._resolve_model(settings, definition, selection.model_id, self._read_cache().get(definition.id))

    def describe_connection(self, provider_id: str) -> dict[str, str] | None:
        """Name, endpoint and key source of a connection; None when it is not configured here."""
        settings = load_settings()
        try:
            definition = self._provider(provider_id)
        except ProviderError:
            return None
        return {
            "name": definition.name,
            "endpoint": self._endpoint(settings, definition),
            "credential": self._credential_source(settings, definition),
        }

    def list_providers(self) -> list[ProviderStatus]:
        try:
            settings: AppSettings | None = load_settings()
        except (OSError, ValueError):
            settings = None
        result = []
        for definition in self._connections().values():
            source = self._credential_source(settings, definition)
            result.append(ProviderStatus(definition.id, definition.name, definition.auth_methods, source != "none", source))
        return result

    async def list_models(self, *, refresh: bool = False) -> ModelCatalog:
        settings = load_settings()
        failures: list[str] = []
        for definition in self._connections().values():
            if self._credential_source(settings, definition) == "none":
                continue
            if refresh and not await self._fetch_models(settings, definition):
                failures.append(f"failed to refresh {definition.name} models, showing saved models")
        models = self._catalog(settings)
        return ModelCatalog(models, "; ".join(failures) or None)

    async def login(self, provider_id: str, method: str, interaction) -> str:
        """Save a key for a connection, or add a named connection; returns its id."""
        if method == "connection":
            return await self._add_connection(interaction)
        definition = self._provider(provider_id)
        if method not in definition.auth_methods:
            raise ValueError(f"{definition.name} does not support {method} login.")
        if method == "oauth":
            credential = await OAUTH_FLOWS[provider_id].login(interaction)
        else:
            key = (await interaction.prompt("secret", f"{definition.name} API key")).strip()
            if not key:
                raise ValueError("Login canceled.")
            credential = Credential(type="api_key", key=key)
        self.credentials.set(provider_id, credential)
        await self._fetch_models(load_settings(), definition)
        return provider_id

    async def _add_connection(self, interaction) -> str:
        name = (await interaction.prompt("text", "Connection name")).strip()
        if not name:
            raise ValueError("Login canceled.")
        connection_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
        if not CONNECTION_ID_PATTERN.fullmatch(connection_id):
            raise ValueError("A connection name needs at least one letter or digit.")
        if connection_id in self.providers:
            raise ValueError(f"{connection_id} is a built-in provider; log in to it directly or choose another name.")
        base_url = (await interaction.prompt("text", "Base URL (OpenAI-compatible, e.g. https://host/v1)")).strip()
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Base URL must be an http(s) URL.")
        model = (await interaction.prompt("text", "Model id (empty: use the endpoint model list)")).strip()
        key = (await interaction.prompt("secret", f"{name} API key")).strip()
        if not key:
            raise ValueError("Login canceled.")
        self.credentials.set_connection(connection_id, name, base_url, model, Credential(type="api_key", key=key))
        await self._fetch_models(load_settings(), self._provider(connection_id))
        return connection_id

    async def refresh_stale_models(self) -> None:
        """Refresh each configured provider once; ordinary reads remain offline."""
        try:
            settings = load_settings()
            cache = self._read_cache()
            for definition in self._connections().values():
                if not refreshable_models_api(_effective_api(settings, definition)):
                    continue
                if self._resolve_credential(settings, definition) is None:
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
        credential = self._resolve_credential(settings, definition)
        if credential is None:
            raise ProviderError(
                f"{definition.name} is not configured. Run /login or set {definition.environment_key}.",
                status="rejected", code="provider_not_configured",
            )
        endpoint = self._endpoint(settings, definition)
        key = self._api_key(definition, credential)
        efforts = next((model.reasoning_efforts for model in definition.fallback_models if model.id == selection.model_id), ())
        # LongCat documents a thinking toggle, not OpenAI reasoning_effort.
        # A saved effort from a previous model must not become an unsupported field.
        reasoning_effort = "" if definition.id == "longcat" else selection.reasoning_effort
        if definition.api == "openai-chat":
            from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient

            return OpenAIChatCompletionsClient(
                build_async_client(key, endpoint, max_retries=14), selection.model_id, reasoning_effort,
                workspace_root=workspace_root, reasoning_efforts=efforts,
            )
        if definition.api == "openai-responses":
            from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient

            return OpenAIResponsesClient(
                build_async_client(key, endpoint), selection.model_id, selection.reasoning_effort,
                workspace_root=workspace_root, reasoning_efforts=efforts, subscription=credential.type == "oauth",
            )
        if definition.api == "anthropic-messages":
            from agent.infrastructure.llm.anthropic_messages import AnthropicMessagesClient

            return AnthropicMessagesClient(api_key=credential.key, model=selection.model_id, base_url=endpoint)
        if definition.api == "google-generative-ai":
            from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient

            return GoogleGenerativeAIClient(api_key=credential.key, model=selection.model_id, base_url=endpoint)
        raise ProviderError(f"Unsupported provider API: {definition.api}", status="rejected", code="unsupported_api")

    @staticmethod
    def unavailable_client(selection: ModelSelection, error: ProviderError):
        return _UnavailableChatClient(selection.model_id, error)

    def _catalog(self, settings: AppSettings) -> list[ModelDefinition]:
        cache = self._read_cache()
        result: list[ModelDefinition] = []
        for definition in self._connections().values():
            if self._credential_source(settings, definition) == "none":
                continue
            entry = cache.get(definition.id)
            items = self._cached_models(entry, settings, definition)
            models = [self._resolve_model(settings, definition, _item_id(item), entry, cached=item) for item in items]
            if not models:
                models = [self._resolve_model(settings, definition, model.id, entry) for model in definition.fallback_models]
            result.extend(models)
        current = ModelSelection(settings.provider, settings.model)
        definition = self.providers.get(current.provider_id)
        if definition is not None and not any(
            model.provider_id == current.provider_id and model.id == current.model_id for model in result
        ):
            result.append(self._resolve_model(settings, definition, current.model_id, cache.get(definition.id)))
        return result

    def _resolve_model(self, settings, definition, model_id: str, entry, *, cached=None) -> ModelDefinition:
        base = _selection_model(settings, definition, ModelSelection(definition.id, model_id))
        if cached is None:
            cached = next((item for item in self._cached_models(entry, settings, definition) if _item_id(item) == model_id), {})
        capability = None
        context_window = None
        endpoint = self._endpoint(settings, definition)
        if isinstance(entry, dict) and entry.get("base_url") == endpoint:
            value = cached.get("image_input") if isinstance(cached, dict) else None
            capability = value if type(value) is bool else None
            context_window = _positive_integer(cached.get("context_window")) if isinstance(cached, dict) else None
        if capability is None or context_window is None:
            catalog_endpoint = endpoint.rstrip("/")
            if catalog_endpoint == "https://api.deepseek.com":
                catalog_endpoint += "/v1"
            candidates = self.providers.values() if definition.id == "openai-compatible" else (definition,)
            for candidate in candidates:
                if catalog_endpoint and catalog_endpoint == candidate.default_base_url.rstrip("/"):
                    known = next((model for model in candidate.fallback_models if model.id == model_id), None)
                    if known is not None:
                        if capability is None:
                            capability = known.image_input
                        if context_window is None:
                            context_window = known.context_window
                    break
        return replace(base, image_input=capability, context_window=context_window)

    async def _fetch_models(self, settings: AppSettings, definition) -> bool:
        if not refreshable_models_api(_effective_api(settings, definition)):
            return True
        credential = self._resolve_credential(settings, definition)
        if credential is None:
            return False

        client = None
        try:
            endpoint = self._endpoint(settings, definition)
            client = build_async_client(self._api_key(definition, credential), endpoint, max_retries=0)
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
                models = [{"id": _item_id(item)} for item in data]
                if any(not item["id"] for item in models):
                    raise ValueError("Invalid model identifier")
            if not models:
                logger.debug("Model refresh returned an empty list for %s", definition.id)
                return False
            cache = self._read_cache()
            previous = cache.get(definition.id)
            old = {_item_id(item): item for item in self._cached_models(previous, settings, definition)
                   if isinstance(item, dict)} if isinstance(previous, dict) else {}
            for model, raw in zip(models, data):
                capability = _remote_image_input(raw, definition.id)
                if capability is None:
                    value = old.get(model["id"], {}).get("image_input")
                    capability = value if type(value) is bool else None
                if capability is not None:
                    model["image_input"] = capability
                context_window = _remote_context_window(raw, definition.id)
                if context_window is None:
                    context_window = _positive_integer(old.get(model["id"], {}).get("context_window"))
                if context_window is not None:
                    model["context_window"] = context_window
            self._write_cache(cache | {definition.id: {
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

    def _api_key(self, definition: ProviderDefinition, credential: Credential) -> ApiKey:
        """The key; for a signed-in account its token, refreshed before each request that needs it."""
        if credential.type != "oauth":
            return credential.key
        flow = OAUTH_FLOWS[definition.id]
        current = credential

        async def access() -> str:
            nonlocal current
            if flow.expiring(current):
                renewed = await asyncio.to_thread(self.credentials.renew, definition.id, flow.fresh)
                if renewed is None:
                    raise ProviderError(f"Signed out of {definition.name}. Run /login.", status="rejected", code="provider_not_configured")
                current = renewed
            return current.access

        return access

    def _connections(self) -> dict[str, ProviderDefinition]:
        return self.providers | {item.id: item for item in self.credentials.connections() if item.id not in self.providers}

    def _provider(self, provider_id: str) -> ProviderDefinition:
        definition = self._connections().get(provider_id)
        if definition is None:
            raise ProviderError(
                f"Connection {provider_id or '(none)'} is not configured. Run /login, or choose another model with /model.",
                status="rejected", code="connection_missing",
            )
        return definition

    def _credential_source(self, settings: AppSettings | None, definition: ProviderDefinition) -> str:
        if settings is not None and settings.provider == definition.id and settings.api_key:
            return "settings"
        if self.credentials.get(definition.id) is not None:
            return "stored"
        env_name = definition.environment_key
        return "environment" if env_name and os.getenv(env_name, "").strip() else "none"

    def _resolve_credential(self, settings: AppSettings, definition: ProviderDefinition) -> Credential | None:
        provider_id = definition.id
        if settings.provider == provider_id and settings.api_key:
            value = settings.api_key
            if value.startswith("$"):
                value = os.getenv(value[1:], "")
            if value:
                return Credential(type="api_key", key=value)
        stored = self.credentials.get(provider_id)
        if stored is not None:
            return stored
        env_name = definition.environment_key
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
    """Stands in for a connection that cannot be used; every request says why."""

    def __init__(self, model: str, error: ProviderError) -> None:
        self.model = model
        self.error = error

    async def create(self, *args, **kwargs):
        raise ProviderError(str(self.error), status="rejected", code=self.error.code)

    async def stream(self, *args, **kwargs):
        raise ProviderError(str(self.error), status="rejected", code=self.error.code)
        yield  # unreachable; keeps stream an async iterator so turns see the ProviderError

    async def close(self) -> None:
        return None


def _effective_api(settings: AppSettings, definition) -> str:
    return settings.api if definition.id == "openai-compatible" else definition.api


def _selection_model(settings: AppSettings, definition, selection: ModelSelection) -> ModelDefinition:
    for model in definition.fallback_models:
        if model.id == selection.model_id:
            return model
    api = _effective_api(settings, definition)
    return ModelDefinition(definition.id, selection.model_id, api, default_reasoning_efforts(api))


def _item_id(item: Any) -> str:
    return str(item.get("id") or "").strip() if isinstance(item, dict) else str(getattr(item, "id", "") or "").strip()


def _remote_image_input(item: Any, provider_id: str) -> bool | None:
    data = item if isinstance(item, dict) else item.model_dump() if hasattr(item, "model_dump") else {}
    if provider_id == "openrouter":
        architecture = data.get("architecture")
        values = architecture.get("input_modalities") if isinstance(architecture, dict) else None
        if isinstance(values, list) and values and all(isinstance(value, str) for value in values):
            return "image" in values
    if provider_id == "mistral":
        capabilities = data.get("capabilities")
        vision = capabilities.get("vision") if isinstance(capabilities, dict) else None
        if type(vision) is bool:
            return vision
    return None


def _positive_integer(value: Any) -> int | None:
    return value if type(value) is int and value > 0 else None


def _remote_context_window(item: Any, provider_id: str) -> int | None:
    """Only consume token limits from documented model-list schemas."""
    data = item if isinstance(item, dict) else item.model_dump() if hasattr(item, "model_dump") else {}
    field = {"openrouter": "context_length", "mistral": "max_context_length", "groq": "context_window"}.get(provider_id)
    return _positive_integer(data.get(field)) if field else None
