"""Session metadata helpers."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any

from agent.domain.skills import SKILL_NAME_PATTERN


NAME_LIMIT = 80
# The automatic title is the first message; long enough to recognise, and
# every list clips it to its own width.
TITLE_LIMIT = 80
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def normalize_name(value: str) -> str:
    """One clean line: control characters dropped, whitespace collapsed, bounded."""
    clean = " ".join(_CONTROL.sub("", str(value or "")).split())
    clean = "".join(char for char in clean if char.isprintable())
    if not clean:
        raise ValueError("A name cannot be empty.")
    return clean[:NAME_LIMIT].rstrip()


def automatic_title(first_message: str) -> str:
    return " ".join(str(first_message or "").split())[:TITLE_LIMIT].rstrip()


def display_title(meta: dict[str, Any]) -> str:
    """What every list shows: the name the user gave, otherwise the first message."""
    name = meta.get("name")
    if isinstance(name, str) and name.strip():
        return name
    title = meta.get("title")
    # "Untitled" is what older versions stored before the first message.
    return title if isinstance(title, str) and title not in {"", "Untitled"} else ""


def new_session_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def session_index_entry(
    session_id: str,
    meta: dict[str, Any],
    *,
    message_count: int,
    tool_call_count: int,
    preview: str,
) -> dict[str, Any]:
    return {
        "id": session_id,
        "title": display_title(meta),
        "name": meta.get("name") or None,
        "updated_at": meta.get("updated_at", ""),
        "size": {"messages": message_count, "tool_calls": tool_call_count},
        "preview": preview,
        "workspace_root": meta.get("workspace_root"),
        "project_id": meta.get("project_id"),
        "owner_agent_id": meta.get("owner_agent_id"),
        "session_type": meta.get("session_type"),
        "parent_session_id": meta.get("parent_session_id"),
        # So lists can show what each conversation runs on without opening it.
        "provider": meta.get("provider") or None,
        "model": meta.get("model") or None,
        "reasoning_effort": meta.get("reasoning_effort") or None,
        "selection_source": meta.get("selection_source") if isinstance(meta.get("selection_source"), dict) else None,
        "has_user_message": True,
    }


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


def normalize_skill_catalog(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        raw_name = item.get("name")
        raw_description = item.get("description")
        raw_scope = item.get("scope")
        if not all(isinstance(field, str) for field in (raw_name, raw_description, raw_scope)):
            continue
        name = raw_name.strip()
        description = raw_description.strip()
        scope = raw_scope.strip().lower()
        key = name.lower()
        if (
            not SKILL_NAME_PATTERN.fullmatch(name)
            or not description
            or "\n" in description
            or "\r" in description
            or scope not in {"user", "project", "agent"}
            or key in seen
        ):
            continue
        seen.add(key)
        entries.append({"name": name, "description": description, "scope": scope})
    entries.sort(key=lambda item: item["name"].lower())
    return entries


def new_session_meta(
    *,
    session_id: str,
    now: str,
    model: str | None,
    cwd: str,
    workspace_root: str,
    project_id: str | None = None,
    owner_agent_id: str | None = None,
    session_type: str | None = None,
    parent_session_id: str | None = None,
    reasoning_effort: str = "",
    provider: str = "openai-compatible",
    selection_source: dict[str, str] | None = None,
) -> dict[str, Any]:
    meta = {
        "schema_version": "2.0",
        "session_id": session_id,
        "title": "",
        "created_at": now,
        "updated_at": now,
        "model": model,
        "provider": provider,
        "cwd": cwd,
        "workspace_root": workspace_root,
        "message_count": 0,
        "tool_call_count": 0,
        "auto_compact_window": default_auto_compact_window(),
    }
    if reasoning_effort:
        meta["reasoning_effort"] = reasoning_effort
    if selection_source:
        meta["selection_source"] = dict(selection_source)
    for key, value in {
        "project_id": project_id,
        "owner_agent_id": owner_agent_id,
        "session_type": session_type or "standalone_project",
        "parent_session_id": parent_session_id,
    }.items():
        if value is not None:
            meta[key] = value
    return meta


def sync_session_counts(meta: dict[str, Any], *, message_count: int, tool_call_count: int) -> bool:
    changed = False
    for key, expected in (("message_count", message_count), ("tool_call_count", tool_call_count)):
        if type(meta.get(key)) is not int or meta[key] != expected:
            meta[key] = expected
            changed = True
    return changed
