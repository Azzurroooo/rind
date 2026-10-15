"""Load and update user-level provider and model configurations in RIND_HOME/providers.json."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any
from urllib.parse import urlparse

from filelock import FileLock

from agent.domain.models import ModelDefinition, ProviderDefinition
from agent.infrastructure.paths import resolve_rind_home
from agent.infrastructure.settings import REASONING_EFFORTS

API_TYPES = ("openai-chat", "openai-responses", "anthropic-messages", "google-generative-ai")

PROTOCOL_OPTIONS = (
    "openai-chat · OpenAI Chat Completions",
    "openai-responses · OpenAI Responses",
    "anthropic-messages · Anthropic Messages",
    "google-generative-ai · Google Generative AI",
)

_PROVIDER_KEYS = frozenset({"name", "api", "baseUrl", "envKey", "models"})
_MODEL_KEYS = frozenset({"api", "contextWindow", "imageInput", "reasoningEfforts"})


@dataclass(frozen=True, slots=True)
class UserModelConfig:
    api: str | None = None
    reasoning_efforts: tuple[str, ...] | None = None
    context_window: int | None = None
    image_input: bool | None = None


def default_providers_path() -> Path:
    return (resolve_rind_home() / "providers.json").resolve()


def load_providers(
    path: Path | None = None,
    builtin: dict[str, ProviderDefinition] | None = None,
) -> tuple[dict[str, ProviderDefinition], dict[str, dict[str, UserModelConfig]]]:
    """Merge built-in providers with user overrides and custom providers from providers.json."""
    if builtin is None:
        from agent.infrastructure.llm.catalog import PROVIDERS
        builtin = PROVIDERS
    target = (path or default_providers_path()).expanduser().resolve()
    merged = dict(builtin)
    user_models: dict[str, dict[str, UserModelConfig]] = {}
    if not target.exists():
        return merged, user_models
    root = _read_json_object(target)
    entries = root.get("providers") if isinstance(root.get("providers"), dict) else root
    for raw_id, raw_provider in entries.items():
        provider_id = raw_id.strip() if isinstance(raw_id, str) else ""
        if not provider_id or not isinstance(raw_provider, dict):
            raise ValueError("Invalid providers.json: provider entries must map non-empty ids to JSON objects.")
        unknown = set(raw_provider) - _PROVIDER_KEYS
        if unknown:
            raise ValueError(
                f"Invalid providers.json: unknown field(s) {', '.join(sorted(unknown))} in provider '{provider_id}'."
            )
        base = builtin.get(provider_id)
        name = _optional_nonempty_str(raw_provider, "name", f"provider '{provider_id}'") or (
            base.name if base is not None else provider_id
        )
        api = _optional_api(raw_provider, "api", f"provider '{provider_id}'") or (
            base.api if base is not None else "openai-chat"
        )
        raw_url = _optional_nonempty_str(raw_provider, "baseUrl", f"provider '{provider_id}'")
        if raw_url is not None:
            if not is_valid_http_url(raw_url):
                raise ValueError(f"Invalid providers.json: baseUrl for '{provider_id}' must be an http(s) URL.")
            base_url = raw_url.rstrip("/")
        elif base is not None:
            base_url = base.default_base_url
        else:
            raise ValueError(f"Invalid providers.json: custom provider '{provider_id}' requires baseUrl.")
        env_key = _optional_nonempty_str(raw_provider, "envKey", f"provider '{provider_id}'") or (
            base.environment_key if base is not None else ""
        )
        parsed_models = _parse_models(provider_id, raw_provider.get("models"))
        if parsed_models:
            user_models[provider_id] = parsed_models
        fallback_models = _merge_fallback_models(provider_id, api, base, parsed_models)
        merged[provider_id] = ProviderDefinition(
            id=provider_id,
            name=name,
            api=api,
            default_base_url=base_url,
            auth_methods=base.auth_methods if base is not None else ("api_key",),
            environment_key=env_key,
            fallback_models=fallback_models,
        )
    return merged, user_models


def save_custom_provider(
    provider_id: str,
    *,
    name: str,
    api: str,
    base_url: str,
    model: str = "",
    path: Path | None = None,
) -> None:
    """Persist a custom provider definition in providers.json atomically."""
    if api not in API_TYPES:
        raise ValueError(f"Unsupported api: {api}")
    if not is_valid_http_url(base_url):
        raise ValueError("Base URL must be an http(s) URL.")
    clean_url = base_url.strip().rstrip("/")
    target = (path or default_providers_path()).expanduser().resolve()
    lock = FileLock(str(target) + ".lock")
    with lock:
        root = _read_json_object(target) if target.exists() else {}
        providers_map = dict(root["providers"]) if isinstance(root.get("providers"), dict) else dict(root)
        existing = providers_map.get(provider_id)
        entry: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
        entry["name"] = name
        entry["api"] = api
        entry["baseUrl"] = clean_url
        if model:
            models = dict(entry.get("models")) if isinstance(entry.get("models"), dict) else {}
            models.setdefault(model, {})
            entry["models"] = models
        providers_map[provider_id] = entry
        payload = {"providers": providers_map}
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        temporary = Path(temporary_name)
        try:
            os.close(fd)
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)


def is_valid_http_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _parse_models(provider_id: str, value: Any) -> dict[str, UserModelConfig]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"Invalid providers.json: models for '{provider_id}' must be a JSON object.")
    result: dict[str, UserModelConfig] = {}
    for raw_model_id, raw_cfg in value.items():
        model_id = raw_model_id.strip() if isinstance(raw_model_id, str) else ""
        if not model_id or not isinstance(raw_cfg, dict):
            raise ValueError(
                f"Invalid providers.json: models in '{provider_id}' must map non-empty model ids to JSON objects."
            )
        unknown = set(raw_cfg) - _MODEL_KEYS
        if unknown:
            raise ValueError(
                f"Invalid providers.json: unknown field(s) {', '.join(sorted(unknown))} in model '{provider_id}/{model_id}'."
            )
        where = f"model '{provider_id}/{model_id}'"
        api = _optional_api(raw_cfg, "api", where)
        context_window = None
        if "contextWindow" in raw_cfg:
            tokens = raw_cfg["contextWindow"]
            if type(tokens) is not int or tokens <= 0:
                raise ValueError(f"Invalid providers.json: contextWindow in {where} must be a positive integer.")
            context_window = tokens
        image_input = None
        if "imageInput" in raw_cfg:
            if type(raw_cfg["imageInput"]) is not bool:
                raise ValueError(f"Invalid providers.json: imageInput in {where} must be a boolean.")
            image_input = raw_cfg["imageInput"]
        efforts = None
        if "reasoningEfforts" in raw_cfg:
            raw_efforts = raw_cfg["reasoningEfforts"]
            if not isinstance(raw_efforts, list) or not all(
                isinstance(item, str) and item.strip().lower() in REASONING_EFFORTS for item in raw_efforts
            ):
                raise ValueError(
                    f"Invalid providers.json: reasoningEfforts in {where} must be a list of {', '.join(REASONING_EFFORTS)}."
                )
            efforts = tuple(dict.fromkeys(item.strip().lower() for item in raw_efforts))
        result[model_id] = UserModelConfig(
            api=api,
            reasoning_efforts=efforts,
            context_window=context_window,
            image_input=image_input,
        )
    return result


def _merge_fallback_models(
    provider_id: str,
    provider_api: str,
    base: ProviderDefinition | None,
    user_models: dict[str, UserModelConfig],
) -> tuple[ModelDefinition, ...]:
    existing_by_id = {model.id: model for model in (base.fallback_models if base is not None else ())}
    ordered_ids = [model.id for model in (base.fallback_models if base is not None else ())]
    for model_id in user_models:
        if model_id not in existing_by_id:
            ordered_ids.append(model_id)
    result: list[ModelDefinition] = []
    for model_id in ordered_ids:
        existing = existing_by_id.get(model_id)
        cfg = user_models.get(model_id)
        model_api = cfg.api if cfg and cfg.api else provider_api
        if cfg and cfg.reasoning_efforts is not None:
            efforts = cfg.reasoning_efforts
        elif existing is not None and model_api == existing.api:
            efforts = existing.reasoning_efforts
        else:
            efforts = () if model_api in ("anthropic-messages", "google-generative-ai") else REASONING_EFFORTS
        context_window = cfg.context_window if cfg and cfg.context_window is not None else (
            existing.context_window if existing is not None else None
        )
        image_input = cfg.image_input if cfg and cfg.image_input is not None else (
            existing.image_input if existing is not None else None
        )
        result.append(
            ModelDefinition(
                provider_id=provider_id,
                id=model_id,
                api=model_api,
                reasoning_efforts=efforts,
                context_window=context_window,
                image_input=image_input,
            )
        )
    return tuple(result)


def _optional_nonempty_str(data: dict[str, Any], key: str, where: str) -> str | None:
    if key not in data:
        return None
    value = data[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Invalid providers.json: {key} in {where} must be a non-empty string.")
    return value.strip()


def _optional_api(data: dict[str, Any], key: str, where: str) -> str | None:
    value = _optional_nonempty_str(data, key, where)
    if value is not None and value not in API_TYPES:
        raise ValueError(f"Invalid providers.json: Unsupported api '{value}' in {where} (must be one of {', '.join(API_TYPES)}).")
    return value


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid providers.json: {path} ({exc})") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Invalid providers.json: {path} must contain a JSON object.")
    return value
