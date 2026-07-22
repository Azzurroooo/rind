"""Load user-level Rind settings."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import platform
from pathlib import Path
from typing import Any
import uuid

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
DEFAULT_USER_AGENT = build_default_user_agent()
DEFAULT_SETTINGS_TEMPLATE = {
    "model": "gpt-5.5",
    "apiKey": "",
    "baseUrl": "",
    "reasoningEffort": "xhigh",
}


@dataclass(frozen=True, slots=True)
class AppSettings:
    settings_path: Path
    settings_exists: bool
    model: str
    api_key: str
    base_url: str
    reasoning_effort: str
    user_agent: str = DEFAULT_USER_AGENT


def validate_settings(settings: AppSettings) -> None:
    if not settings.api_key:
        raise ValueError(
            f"OpenAI apiKey is required. Create {settings.settings_path} or set OPENAI_API_KEY."
        )


def default_settings_path() -> Path:
    override = os.getenv("RIND_SETTINGS_PATH", "").strip()
    if override:
        return Path(override).expanduser()
    return resolve_rind_home() / "settings.json"


def load_settings(path: str | Path | None = None) -> AppSettings:
    settings_path = Path(path).expanduser() if path else default_settings_path()
    data = _read_json_object(settings_path) if settings_path.exists() else {}

    return AppSettings(
        settings_path=settings_path,
        settings_exists=settings_path.exists(),
        model=_string(data, "model") or os.getenv("DEFAULT_MODEL", "").strip() or DEFAULT_MODEL,
        api_key=_configured_or_env(data, "apiKey", "OPENAI_API_KEY"),
        base_url=_string(data, "baseUrl") or os.getenv("OPENAI_API_BASE", "").strip() or DEFAULT_BASE_URL,
        reasoning_effort=_configured_or_env(data, "reasoningEffort", "MODEL_REASONING_EFFORT"),
        user_agent=DEFAULT_USER_AGENT,
    )


def ensure_user_settings_template() -> Path | None:
    if os.getenv("RIND_SETTINGS_PATH", "").strip():
        return None
    settings_path = default_settings_path()
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    if not settings_path.exists():
        settings_path.write_text(
            json.dumps(DEFAULT_SETTINGS_TEMPLATE, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return settings_path


def save_settings_patch(patch: dict[str, Any], path: str | Path | None = None) -> AppSettings:
    if not isinstance(patch, dict):
        raise ValueError("Settings patch must be a JSON object")
    settings_path = Path(path).expanduser() if path else default_settings_path()
    data = _read_json_object(settings_path) if settings_path.exists() else dict(DEFAULT_SETTINGS_TEMPLATE)
    data.update(patch)
    _write_json_object(settings_path, data)
    return load_settings(settings_path)


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid settings.json: {path} ({exc})") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Invalid settings.json: {path} must contain a JSON object")
    return value


def _write_json_object(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _configured_or_env(data: dict[str, Any], key: str, env_key: str) -> str:
    if key in data:
        return _string(data, key)
    return os.getenv(env_key, "").strip()
