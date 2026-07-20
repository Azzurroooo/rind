"""Prompt text and bottom toolbar for the interactive CLI."""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from agent.interfaces.cli.formatting import clip_text, display_value

_GIT_CACHE_TTL_SECONDS = 2.0


def prompt_message() -> str:
    return "\nYou > "


def prompt_continuation(width: int, line_number: int, is_soft_wrap: bool) -> str:
    return "  ... "


def prompt_toolbar(
    session,
    *,
    debug: bool = False,
    cwd: str | Path | None = None,
    usage: dict[str, object] | None = None,
    git_status: "GitPromptStatus | None" = None,
) -> str:
    items = [
        f"session {_short_session_id(getattr(session, 'session_id', None))}",
        f"model {clip_text(display_value(getattr(session, 'model', None)), 26)}",
    ]
    usage_text = _usage_summary(usage)
    if usage_text:
        items.append(usage_text)
    git_text = _git_summary(git_status)
    if git_text:
        items.append(git_text)
    items.append(f"cwd {clip_text(_cwd_name(cwd), 28)}")
    if debug:
        items.append("debug on")
    items.extend(
        [
            "Enter send",
            "Ctrl+J newline",
            "Ctrl+O history",
            "Tab complete /commands",
            "Right accept hint",
            "Ctrl+L clear",
            "Ctrl+C draft",
        ]
    )
    return "  |  ".join(items)


@dataclass(slots=True)
class GitPromptStatus:
    branch: str
    dirty: bool = False


class GitPromptStatusProvider:
    def __init__(self, cwd: str | Path | None = None, *, ttl_seconds: float = _GIT_CACHE_TTL_SECONDS):
        self._cwd = str(cwd or Path.cwd())
        self._ttl_seconds = ttl_seconds
        self._cached_at = 0.0
        self._cached_status: GitPromptStatus | None = None

    def current(self) -> GitPromptStatus | None:
        now = time.monotonic()
        if self._cached_at and now - self._cached_at < self._ttl_seconds:
            return self._cached_status
        self._cached_status = _read_git_status(self._cwd)
        self._cached_at = now
        return self._cached_status


def _read_git_status(cwd: str) -> GitPromptStatus | None:
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    if not branch:
        return None
    dirty_output = _run_git(["status", "--porcelain", "--untracked-files=no"], cwd)
    return GitPromptStatus(branch=branch, dirty=bool(dirty_output))


def _run_git(args: list[str], cwd: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=0.5,
            check=False,
        )
    except Exception:
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout.strip()


def _short_session_id(value: object) -> str:
    text = display_value(value)
    if text == "unknown" or len(text) <= 14:
        return text
    return f"{text[:8]}...{text[-4:]}"


def _cwd_name(cwd: str | Path | None) -> str:
    path = Path(cwd) if cwd else Path.cwd()
    name = path.name or str(path)
    return name or "unknown"


def _usage_summary(usage: dict[str, object] | None) -> str:
    if not isinstance(usage, dict):
        return ""

    items = []
    context = _format_percent(usage.get("context_usage_percent"))
    if context:
        items.append(f"ctx {context}")
    else:
        input_tokens = _number(usage.get("input_tokens"))
        window = _number(usage.get("context_window_tokens"))
        if input_tokens is not None and window:
            items.append(f"ctx {_format_count(input_tokens)}/{_format_count(window)}")
        elif input_tokens is not None:
            items.append(f"ctx {_format_count(input_tokens)}")

    cache = _format_percent(usage.get("cache_hit_rate"))
    if cache:
        items.append(f"cache {cache}")
    return " ".join(items)


def _git_summary(status: GitPromptStatus | None) -> str:
    if status is None or not status.branch:
        return ""
    marker = "*" if status.dirty else ""
    return f"git {clip_text(status.branch, 22)}{marker}"


def _format_percent(value: object) -> str:
    number = _number(value)
    if number is None:
        return ""
    percent = number * 100 if abs(number) <= 1 else number
    return f"{percent:.1f}%"


def _format_count(value: float) -> str:
    if abs(value) >= 1000:
        return f"{value / 1000:.1f}k"
    return str(int(value))


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None
