"""Load user-level Rind settings."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import platform
from pathlib import Path
import tempfile
from typing import Any

from filelock import FileLock

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


DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-4o-mini"
REASONING_EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_USER_AGENT = build_default_user_agent()
_DEFAULT_SETTINGS = (
    ("provider", DEFAULT_PROVIDER),
    ("model", DEFAULT_MODEL),
    ("reasoningEffort", ""),
)


@dataclass(frozen=True, slots=True)
class AppSettings:
    settings_path: Path
    settings_exists: bool
    model: str
    reasoning_effort: str
    user_agent: str = DEFAULT_USER_AGENT
    server_token: str = ""
    provider: str = DEFAULT_PROVIDER


def default_settings_path() -> Path:
    return (resolve_rind_home() / "settings.json").resolve()


def ensure_user_settings() -> Path:
    path = default_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(dict(_DEFAULT_SETTINGS), handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    finally:
        if descriptor != -1:
            os.close(descriptor)
    return path


def load_settings() -> AppSettings:
    """The user's global default settings. A project folder never supplies settings."""
    settings_path = default_settings_path()
    data = _read_json_object(settings_path) if settings_path.exists() else {}
    return _build_settings(settings_path, data)


def save_settings(
    *,
    provider: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
) -> AppSettings:
    """Update global defaults in settings.json atomically."""
    path = default_settings_path()
    lock = FileLock(str(path) + ".lock")
    with lock:
        data = _read_json_object(path) if path.exists() else dict(_DEFAULT_SETTINGS)
        if provider is not None:
            data["provider"] = str(provider).strip() or DEFAULT_PROVIDER
        if model is not None:
            data["model"] = str(model).strip() or DEFAULT_MODEL
        if reasoning_effort is not None:
            data["reasoningEffort"] = normalize_reasoning_effort(reasoning_effort)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            os.close(fd)
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return _build_settings(path, data)


def normalize_reasoning_effort(value: Any) -> str:
    effort = str(value or "").strip().lower()
    if effort and effort not in REASONING_EFFORTS:
        raise ValueError(
            f"Reasoning effort must be one of {', '.join(REASONING_EFFORTS)}."
        )
    return effort


def _build_settings(settings_path: Path, data: dict[str, Any]) -> AppSettings:
    return AppSettings(
        settings_path=settings_path,
        settings_exists=settings_path.exists(),
        model=_string(data, "model") or DEFAULT_MODEL,
        reasoning_effort=_string(data, "reasoningEffort"),
        user_agent=DEFAULT_USER_AGENT,
        server_token=_string(data, "serverToken"),
        provider=_string(data, "provider") or DEFAULT_PROVIDER,
    )


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


