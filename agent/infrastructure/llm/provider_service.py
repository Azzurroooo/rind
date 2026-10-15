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
from agent.infrastructure.providers import (
    API_TYPES,
    PROTOCOL_OPTIONS,
    UserModelConfig,
    is_valid_http_url,
    load_providers,
    save_custom_provider,
)
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
        self.providers_path = self.credentials.path.with_name("providers.json")

    def default_selection(self) -> ModelSelection:
        settings = load_settings()
        return ModelSelection(settings.provider, settings.model, settings.reasoning_effort)

    def resolve_selection(self, selection: ModelSelection, *, settings: AppSettings | None = None) -> ModelDefinition:
        connections, user_models = self._loaded_providers()
        definition = self._provider_from(connections, selection.provider_id)
        return self._resolve_model(
            definition,
            user_models.get(definition.id, {}),
            selection.model_id,
            self._read_cache().get(definition.id),
        )

    def describe_connection(self, provider_id: str) -> dict[str, str] | None:
        """Name, endpoint and key source of a connection; None when it is not configured here."""
        try:
            definition = self._provider(provider_id)
        except ProviderError:
            return None
        return {
            "name": definition.name,
            "endpoint": definition.default_base_url,
            "credential": self._credential_source(definition),
        }

    def list_providers(self) -> list[ProviderStatus]:
        try:
            connections = self._connections()
        except (OSError, ValueError):
            connections = dict(self.providers)
        result = []
        for definition in connections.values():
            source = self._credential_source(definition)
            result.append(ProviderStatus(definition.id, definition.name, definition.auth_methods, source != "none", source))
        return result

    async def list_models(self, *, refresh: bool = False) -> ModelCatalog:
        settings = load_settings()
        connections, user_models = self._loaded_providers()
        failures: list[str] = []
        for definition in connections.values():
            if self._credential_source(definition) == "none":
                continue
            if refresh and not await self._fetch_models(definition):
                failures.append(f"failed to refresh {definition.name} models, showing saved models")
        models = self._catalog(settings, connections, user_models)
        return ModelCatalog(models, "; ".join(failures) or None)

    async def login(self, provider_id: str, method: str, interaction) -> str:
        """Save a key for a connection, or add a custom provider; returns its id."""
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
        await self._fetch_models(definition)
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
        chosen_api = (await interaction.prompt("select", f"API protocol for {name}", options=PROTOCOL_OPTIONS)).strip()
        if not chosen_api:
            raise ValueError("Login canceled.")
        api = chosen_api.split("·", 1)[0].strip()
        if api not in API_TYPES:
            raise ValueError(f"Unsupported API protocol: {api}")
        base_url = (await interaction.prompt("text", "Base URL (e.g. https://host/v1)")).strip()
        if not is_valid_http_url(base_url):
            raise ValueError("Base URL must be an http(s) URL.")
        model = (await interaction.prompt("text", "Model id (empty: use the endpoint model list)")).strip()
        key = (await interaction.prompt("secret", f"{name} API key")).strip()
        if not key:
            raise ValueError("Login canceled.")
        save_custom_provider(
            connection_id,
            name=name,
            api=api,
            base_url=base_url,
            model=model,
            path=self.providers_path,
        )
        self.credentials.set(connection_id, Credential(type="api_key", key=key))
        await self._fetch_models(self._provider(connection_id))
        return connection_id

    async def refresh_stale_models(self) -> None:
        """Refresh each configured provider once; ordinary reads remain offline."""
        try:
            cache = self._read_cache()
            for definition in self._connections().values():
                if not refreshable_models_api(definition.api):
                    continue
                if self._resolve_credential(definition) is None:
                    continue
                entry = cache.get(definition.id)
                if isinstance(entry, dict) and entry.get("base_url") == definition.default_base_url:
                    refreshed_at = entry.get("refreshed_at")
                    if (
                        self._cached_models(entry, definition)
                        and type(refreshed_at) in (int, float)
                        and math.isfinite(refreshed_at)
                        and 0 <= time.time() - refreshed_at < MODEL_CACHE_TTL
                    ):
                        continue
                await self._fetch_models(definition)
        except Exception as exc:
            logger.debug("Background model refresh failed (%s)", type(exc).__name__)

    def logout(self, provider_id: str) -> bool:
        return self.credentials.delete(provider_id)

    async def create_chat_client(self, settings: AppSettings, selection: ModelSelection):
        definition = self._provider(selection.provider_id)
        credential = self._resolve_credential(definition)
        if credential is None:
            hint = f" or set {definition.environment_key}" if definition.environment_key else ""
            raise ProviderError(
                f"{definition.name} is not configured. Run /login{hint}.",
                status="rejected", code="provider_not_configured",
            )
        endpoint = definition.default_base_url
        key = self._api_key(definition, credential)
        known_model = next((model for model in definition.fallback_models if model.id == selection.model_id), None)
        api = known_model.api if known_model is not None else definition.api
        efforts = known_model.reasoning_efforts if known_model is not None else ()
        # LongCat documents a thinking toggle, not OpenAI reasoning_effort.
        # A saved effort from a previous model must not become an unsupported field.
        reasoning_effort = "" if definition.id == "longcat" else selection.reasoning_effort
        if api == "openai-chat":
            from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient

            return OpenAIChatCompletionsClient(
                build_async_client(key, endpoint, max_retries=14), selection.model_id, reasoning_effort,
                reasoning_efforts=efforts,
            )
        if api == "openai-responses":
            from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient

            return OpenAIResponsesClient(
                build_async_client(key, endpoint), selection.model_id, selection.reasoning_effort,
                reasoning_efforts=efforts, subscription=credential.type == "oauth",
            )
        if api == "anthropic-messages":
            from agent.infrastructure.llm.anthropic_messages import AnthropicMessagesClient

            return AnthropicMessagesClient(api_key=credential.key, model=selection.model_id, base_url=endpoint)
        if api == "google-generative-ai":
            from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient

            return GoogleGenerativeAIClient(api_key=credential.key, model=selection.model_id, base_url=endpoint)
        raise ProviderError(f"Unsupported provider API: {api}", status="rejected", code="unsupported_api")

    @staticmethod
    def unavailable_client(selection: ModelSelection, error: ProviderError):
        return _UnavailableChatClient(selection.model_id, error)

    def _catalog(
        self,
        settings: AppSettings,
        connections: dict[str, ProviderDefinition],
        user_models: dict[str, dict[str, UserModelConfig]],
    ) -> list[ModelDefinition]:
        cache = self._read_cache()
        result: list[ModelDefinition] = []
        for definition in connections.values():
            if self._credential_source(definition) == "none":
                continue
            entry = cache.get(definition.id)
            provider_user_models = user_models.get(definition.id, {})
            items = self._cached_models(entry, definition)
            models = [self._resolve_model(definition, provider_user_models, _item_id(item), entry, cached=item) for item in items]
            if not models:
                models = [self._resolve_model(definition, provider_user_models, model.id, entry) for model in definition.fallback_models]
            else:
                listed_ids = {model.id for model in models}
                for model_id in provider_user_models:
                    if model_id not in listed_ids:
                        models.append(self._resolve_model(definition, provider_user_models, model_id, entry))
            result.extend(models)
        current = ModelSelection(settings.provider, settings.model)
        definition = connections.get(current.provider_id)
        # The current selection is kept listed only while its connection can run;
        # a model whose provider was logged out is not a choice (opencode hides
        # providers without credentials the same way).
        if definition is not None and self._credential_source(definition) != "none" and not any(
            model.provider_id == current.provider_id and model.id == current.model_id for model in result
        ):
            result.append(
                self._resolve_model(
                    definition,
                    user_models.get(definition.id, {}),
                    current.model_id,
                    cache.get(definition.id),
                )
            )
        return result

    def _resolve_model(
        self,
        definition: ProviderDefinition,
        user_models: dict[str, UserModelConfig],
        model_id: str,
        entry,
        *,
        cached=None,
    ) -> ModelDefinition:
        base = _selection_model(definition, ModelSelection(definition.id, model_id))
        if cached is None:
            cached = next((item for item in self._cached_models(entry, definition) if _item_id(item) == model_id), {})
        capability = None
        context_window = None
        endpoint = definition.default_base_url
        if isinstance(entry, dict) and entry.get("base_url") == endpoint:
            value = cached.get("image_input") if isinstance(cached, dict) else None
            capability = value if type(value) is bool else None
            context_window = _positive_integer(cached.get("context_window")) if isinstance(cached, dict) else None
        if capability is None or context_window is None:
            catalog_endpoint = endpoint.rstrip("/")
            if catalog_endpoint == "https://api.deepseek.com":
                catalog_endpoint += "/v1"
            builtin = self.providers.get(definition.id)
            candidates = (builtin,) if builtin is not None and builtin.fallback_models else self.providers.values()
            for candidate in candidates:
                if candidate is not None and catalog_endpoint and catalog_endpoint == candidate.default_base_url.rstrip("/"):
                    known = next((model for model in candidate.fallback_models if model.id == model_id), None)
                    if known is not None:
                        if capability is None:
                            capability = known.image_input
                        if context_window is None:
                            context_window = known.context_window
                    break
        user_cfg = user_models.get(model_id)
        if user_cfg is not None:
            if user_cfg.image_input is not None:
                capability = user_cfg.image_input
            if user_cfg.context_window is not None:
                context_window = user_cfg.context_window
        return replace(base, image_input=capability, context_window=context_window)

    async def _fetch_models(self, definition) -> bool:
        if not refreshable_models_api(definition.api):
            return True
        credential = self._resolve_credential(definition)
        if credential is None:
            return False

        client = None
        try:
            endpoint = definition.default_base_url
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
            old = {_item_id(item): item for item in self._cached_models(previous, definition)
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

    def _cached_models(self, entry: Any, definition) -> list:
        # Legacy lists have no known endpoint or success time; read them until refreshed.
        if isinstance(entry, dict):
            if entry.get("base_url") != definition.default_base_url:
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

    def _loaded_providers(self) -> tuple[dict[str, ProviderDefinition], dict[str, dict[str, UserModelConfig]]]:
        return load_providers(self.providers_path, self.providers)

    def _connections(self) -> dict[str, ProviderDefinition]:
        return self._loaded_providers()[0]

    def _provider(self, provider_id: str) -> ProviderDefinition:
        return self._provider_from(self._connections(), provider_id)

    @staticmethod
    def _provider_from(connections: dict[str, ProviderDefinition], provider_id: str) -> ProviderDefinition:
        definition = connections.get(provider_id)
        if definition is None:
            raise ProviderError(
                f"Connection {provider_id or '(none)'} is not configured. Run /login, or choose another model with /model.",
                status="rejected", code="connection_missing",
            )
        return definition

    def _credential_source(self, definition: ProviderDefinition) -> str:
        if self.credentials.get(definition.id) is not None:
            return "stored"
        env_name = definition.environment_key
        return "environment" if env_name and os.getenv(env_name, "").strip() else "none"

    def _resolve_credential(self, definition: ProviderDefinition) -> Credential | None:
        stored = self.credentials.get(definition.id)
        if stored is not None:
            return stored
        env_name = definition.environment_key
        value = os.getenv(env_name, "").strip() if env_name else ""
        return Credential(type="api_key", key=value) if value else None

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


def _selection_model(definition, selection: ModelSelection) -> ModelDefinition:
    for model in definition.fallback_models:
        if model.id == selection.model_id:
            return model
    return ModelDefinition(definition.id, selection.model_id, definition.api, default_reasoning_efforts(definition.api))


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
