"""Load user-level Rind settings."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import platform
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from agent.infrastructure.paths import resolve_rind_home
from agent.version import __version__


_USER_AGENT_PRODUCT = "rind"


def build_default_user_agent() -> str:
    """Build a lightweight Codex-style User-Agent for outbound API requests."""
    os_name = _sanitize_header_segment(platform.system() or "unknown")
    os_version = _sanitize_header_segment(platform.release() or "unknown")
    machine = _sanitize_header_segment(platform.machine() or "unknown")
    version = _sanitize_user_agent_token(__version__) or "unknown"
    terminal = _terminal_user_agent_token()
    return f"{_USER_AGENT_PRODUCT}/{version} ({os_name} {os_version}; {machine}) {terminal}"


def _terminal_user_agent_token() -> str:
    if os.getenv("WT_SESSION"):
        return "WindowsTerminal"

    term_program = os.getenv("TERM_PROGRAM", "").strip()
    if term_program:
        token = _sanitize_user_agent_token(term_program)
        version = _sanitize_user_agent_token(os.getenv("TERM_PROGRAM_VERSION", "").strip())
        if token and version:
            return f"{token}/{version}"
        return token or "unknown"

    term = os.getenv("TERM", "").strip()
    if term:
        return _sanitize_user_agent_token(term) or "unknown"

    return "unknown"


def _sanitize_user_agent_token(value: str) -> str:
    return "".join(
        ch if ch.isascii() and (ch.isalnum() or ch in "-_./") else "_"
        for ch in str(value).strip()
    )


def _sanitize_header_segment(value: str) -> str:
    sanitized = "".join(ch if " " <= ch <= "~" else "_" for ch in str(value).strip())
    return sanitized or "unknown"


DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
REASONING_EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_USER_AGENT = build_default_user_agent()


@dataclass(frozen=True, slots=True)
class AppSettings:
    settings_path: Path
    settings_exists: bool
    model: str
    api_key: str
    base_url: str
    reasoning_effort: str
    user_agent: str = DEFAULT_USER_AGENT
    server_token: str = ""
    provider: str = "openai-compatible"
    api: str = "openai-chat"


def default_settings_path() -> Path:
    return (resolve_rind_home() / "settings.json").resolve()


def project_settings_path(workspace_root: str | Path) -> Path:
    return Path(workspace_root).expanduser().resolve() / ".rind" / "settings.json"


def load_settings(workspace_root: str | Path | None = None) -> AppSettings:
    if workspace_root:
        project_path = project_settings_path(workspace_root)
        project_data = _read_optional_json_object(project_path)
        if _has_complete_project_settings(project_data):
            return _build_settings(project_path, project_data)

    settings_path = default_settings_path()
    data = _read_json_object(settings_path) if settings_path.exists() else {}
    return _build_settings(settings_path, data)


def normalize_reasoning_effort(value: Any) -> str:
    effort = str(value or "").strip().lower()
    if effort and effort not in REASONING_EFFORTS:
        raise ValueError(
            f"Reasoning effort must be one of {', '.join(REASONING_EFFORTS)}."
        )
    return effort


def _build_settings(settings_path: Path, data: dict[str, Any]) -> AppSettings:
    provider = _string(data, "provider") or "openai-compatible"
    api = _string(data, "api") or _default_api(provider)
    return AppSettings(
        settings_path=settings_path,
        settings_exists=settings_path.exists(),
        model=_string(data, "model") or DEFAULT_MODEL,
        api_key=_string(data, "apiKey"),
        base_url=_string(data, "baseUrl") or DEFAULT_BASE_URL,
        reasoning_effort=_string(data, "reasoningEffort"),
        user_agent=DEFAULT_USER_AGENT,
        server_token=_string(data, "serverToken"),
        provider=provider,
        api=api,
    )


def _read_optional_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return _read_json_object(path)
    except ValueError:
        return {}


def _has_complete_project_settings(data: dict[str, Any]) -> bool:
    provider = _string(data, "provider")
    model = _string(data, "model")
    if provider and model and provider in {"openai", "anthropic", "deepseek", "openrouter", "openai-compatible"}:
        if provider != "openai-compatible" or _string(data, "baseUrl"):
            return True
    api_key = _string(data, "apiKey")
    base_url = _string(data, "baseUrl")
    model = _string(data, "model")
    parsed = urlparse(base_url)
    return bool(api_key and model and parsed.scheme in {"http", "https"} and parsed.netloc)


def _default_api(provider: str) -> str:
    return {
        "openai": "openai-responses",
        "anthropic": "anthropic-messages",
        "deepseek": "openai-chat",
        "openrouter": "openai-chat",
        "openai-compatible": "openai-chat",
    }.get(provider, "openai-chat")


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid settings.json: {path} ({exc})") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Invalid settings.json: {path} must contain a JSON object")
    return value


def _string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if value is None:
        return ""
    return str(value).strip()
