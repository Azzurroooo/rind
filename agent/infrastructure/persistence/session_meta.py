"""Session metadata helpers."""

from __future__ import annotations

from typing import Any


def default_auto_compact_window() -> dict[str, Any]:
    return {"ordinal": 1}


def normalize_auto_compact_window(window: Any) -> dict[str, Any]:
    normalized = default_auto_compact_window()
    if isinstance(window, dict):
        normalized["ordinal"] = window.get("ordinal", normalized["ordinal"])
    try:
        normalized["ordinal"] = max(1, int(normalized.get("ordinal") or 1))
    except (TypeError, ValueError):
        normalized["ordinal"] = 1
    return normalized


def positive_int_or_none(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def new_session_meta(
    *,
    session_id: str,
    now: str,
    model: str | None,
    cwd: str,
    workspace_root: str,
) -> dict[str, Any]:
    return {
        "schema_version": "2.0",
        "session_id": session_id,
        "title": "Untitled",
        "created_at": now,
        "updated_at": now,
        "model": model,
        "cwd": cwd,
        "workspace_root": workspace_root,
        "message_count": 0,
        "tool_call_count": 0,
        "auto_compact_window": default_auto_compact_window(),
    }


def sync_session_counts(meta: dict[str, Any], *, message_count: int, tool_call_count: int) -> bool:
    changed = False
    if _count_needs_repair(meta.get("message_count"), message_count):
        meta["message_count"] = message_count
        changed = True
    if _count_needs_repair(meta.get("tool_call_count"), tool_call_count):
        meta["tool_call_count"] = tool_call_count
        changed = True
    return changed


def _count_needs_repair(value: Any, expected: int) -> bool:
    return _non_negative_int(value) != expected or value != expected


def _non_negative_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)
