"""Build runtime events for successful file mutations."""

from __future__ import annotations

import json

from agent.application.ports.session_store import SessionStore
from agent.domain.events import FileChangeEvent, event_meta
from agent.domain.tool_payload import ParsedToolCall


def build_file_change_event(
    *,
    session: SessionStore,
    turn_id: str,
    call: ParsedToolCall,
    parsed_args: dict,
    status: str,
    result: str,
) -> FileChangeEvent | None:
    if status != "completed":
        return None
    try:
        payload = json.loads(result)
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return None
    lines = _file_change_lines(call.name, parsed_args)
    if not lines:
        return None
    return FileChangeEvent(
        **event_meta(session, turn_id),
        tool_call_id=call.call_id,
        file_path=str(parsed_args.get("file_path") or ""),
        lines=lines,
    )


def _file_change_lines(tool_name: str, parsed_args: dict) -> list[dict[str, str]]:
    if tool_name == "write_file":
        return [{"kind": "added", "text": line} for line in _split_lines(parsed_args.get("content"))]
    if tool_name == "edit_file":
        removed = [{"kind": "removed", "text": line} for line in _split_lines(parsed_args.get("old_str"))]
        added = [{"kind": "added", "text": line} for line in _split_lines(parsed_args.get("new_str"))]
        return removed + added
    return []


def _split_lines(value: object) -> list[str]:
    if not isinstance(value, str) or not value:
        return []
    return value.splitlines()
