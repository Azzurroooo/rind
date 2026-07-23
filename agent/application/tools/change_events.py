"""Build runtime events for successful file mutations."""

from __future__ import annotations

import json

from agent.application.ports.session_store import SessionStore
from agent.domain.events import FileChangeEvent, event_meta
from agent.domain.tool_payload import ParsedToolCall


def build_file_change_events(
    *,
    session: SessionStore,
    turn_id: str,
    call: ParsedToolCall,
    status: str,
    result: str,
) -> list[FileChangeEvent]:
    if status != "completed" or call.name != "apply_patch":
        return []
    try:
        payload = json.loads(result)
    except Exception:
        return []
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return []
    meta = payload.get("meta")
    files = meta.get("files") if isinstance(meta, dict) else None
    if not isinstance(files, list):
        return []

    events: list[FileChangeEvent] = []
    for file_meta in files:
        if not isinstance(file_meta, dict):
            continue
        path = file_meta.get("path")
        diff = file_meta.get("diff")
        if not isinstance(path, str) or not isinstance(diff, str):
            continue
        lines = _diff_lines(diff)
        if lines:
            events.append(
                FileChangeEvent(
                    **event_meta(session, turn_id),
                    tool_call_id=call.call_id,
                    file_path=path,
                    lines=lines,
                )
            )
    return events


def _diff_lines(diff: str) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    in_hunk = False
    for line in diff.splitlines():
        if line.startswith("@@"):
            in_hunk = True
            continue
        if not in_hunk or not line:
            continue
        if line[0] == "+":
            changes.append({"kind": "added", "text": line[1:]})
        elif line[0] == "-":
            changes.append({"kind": "removed", "text": line[1:]})
    return changes
