"""Snapshot fork of a stored session into a new session directory."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agent.infrastructure.paths import resolve_session_base, validate_session_id
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.persistence.message_projector import INTERNAL_MESSAGE_KINDS
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.infrastructure.persistence.session_index_repository import SessionIndexRepository
from agent.infrastructure.persistence.session_meta import new_session_id, session_index_entry

FORK_TITLE_SUFFIX = " (fork)"
CONTEXT_RECORD_KINDS = frozenset({"skill_snapshot", "skill_catalog"}) | INTERNAL_MESSAGE_KINDS


def fork_session(session_dir: str | Path | None, source_id: str, *, before_message_id: str | None = None) -> str:
    """Copy a stored session snapshot under a new id, optionally truncated before a user message."""
    clean = validate_session_id(source_id)
    root = JsonlSessionStore.resolve_session_root(session_dir)
    source_base = str(resolve_session_base(root, clean))
    files = SessionFiles()

    meta = files.load_json(os.path.join(source_base, "meta.json"))
    if not isinstance(meta, dict):
        raise LookupError(f"Session not found: {clean}")

    messages = files.read_jsonl(os.path.join(source_base, "messages.jsonl"))
    cut = _fork_cut(messages, before_message_id)
    retained = messages[:cut]
    if not any(_is_prompt_message(message) for message in retained):
        raise ValueError("Nothing to fork: the session has no user messages.")

    tool_calls = files.read_jsonl(os.path.join(source_base, "tool_calls.jsonl"))
    compactions = [
        record
        for record in files.read_jsonl(os.path.join(source_base, "compactions.jsonl"))
        if _compaction_end(record) < cut
    ]

    new_id = new_session_id()
    target_base = str(resolve_session_base(root, new_id))
    os.makedirs(target_base, exist_ok=True)
    files.write_jsonl(os.path.join(target_base, "messages.jsonl"), retained)
    files.write_jsonl(os.path.join(target_base, "tool_calls.jsonl"), tool_calls)
    if compactions:
        files.write_jsonl(os.path.join(target_base, "compactions.jsonl"), compactions)

    message_count = sum(1 for message in retained if not _is_context_record(message))
    forked_meta = _forked_meta(
        dict(meta),
        source_id=clean,
        new_id=new_id,
        compactions=compactions,
        message_count=message_count,
        tool_call_count=len(tool_calls),
    )
    files.write_json(os.path.join(target_base, "meta.json"), forked_meta)

    SessionIndexRepository(files, JsonlSessionStore.index_path_for(session_dir)).update_index(
        session_index_entry(
            new_id,
            forked_meta,
            message_count=message_count,
            tool_call_count=len(tool_calls),
            preview=_assistant_preview(retained),
        )
    )
    return new_id


def _fork_cut(messages: list[dict[str, Any]], before_message_id: str | None) -> int:
    if before_message_id is None:
        return len(messages)
    for index, message in enumerate(messages):
        if message.get("id") == before_message_id:
            if not _is_prompt_message(message):
                raise ValueError("Fork point must be a user message.")
            return index
    raise ValueError("Fork message not found.")


def _is_prompt_message(message: dict[str, Any]) -> bool:
    if message.get("role") != "user" or _is_context_record(message):
        return False
    return bool(str(message.get("content") or "").strip())


def _is_context_record(message: dict[str, Any]) -> bool:
    meta = message.get("meta")
    return isinstance(meta, dict) and meta.get("kind") in CONTEXT_RECORD_KINDS


def _compaction_end(record: dict[str, Any]) -> int:
    source = record.get("source")
    if not isinstance(source, dict):
        return 0
    try:
        return int(source.get("message_end_index_exclusive") or 0)
    except (TypeError, ValueError):
        return 0


def _assistant_preview(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "assistant" and str(message.get("content") or "").strip():
            return str(message["content"])[:200]
    return ""


def _forked_meta(
    meta: dict[str, Any],
    *,
    source_id: str,
    new_id: str,
    compactions: list[dict[str, Any]],
    message_count: int,
    tool_call_count: int,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    title = str(meta.get("title") or "Untitled")
    while title.endswith(FORK_TITLE_SUFFIX):
        title = title[: -len(FORK_TITLE_SUFFIX)]
    meta.update(
        {
            "session_id": new_id,
            "title": f"{title}{FORK_TITLE_SUFFIX}",
            "created_at": now,
            "updated_at": now,
            "parent_session_id": source_id,
            "message_count": message_count,
            "tool_call_count": tool_call_count,
        }
    )
    if compactions:
        latest = compactions[-1]
        meta["latest_compaction"] = {
            "id": latest.get("id"),
            "created_at": latest.get("created_at"),
            "policy_version": latest.get("policy_version"),
            "source": latest.get("source"),
        }
        meta["auto_compact_window"] = {"ordinal": len(compactions) + 1}
    else:
        meta.pop("latest_compaction", None)
        meta["auto_compact_window"] = {"ordinal": 1}
    return meta
