"""Project persisted session records into the durable runtime event stream.

The store keeps messages and tool records, not events, so reconnecting clients
rebuild the durable stream from those records; every projected event is durable.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from agent.infrastructure.persistence.message_projector import (
    INTERNAL_MESSAGE_KINDS,
    is_compact_boundary_message,
)

_TERMINAL_EVENT_TYPES = {
    "failed": "turn_failed",
    "cancelled": "turn_cancelled",
    "completed": "turn_completed",
}


def project_durable_events(
    messages: list[dict[str, Any]],
    tool_records: list[dict[str, Any]],
    turn_state: dict[str, Any] | None,
    session_id: str,
) -> list[dict[str, Any]]:
    """Rebuild durable events in chronological message order."""
    records = {
        str(record.get("id")): record
        for record in tool_records
        if isinstance(record, dict) and record.get("id")
    }
    events: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict) or is_compact_boundary_message(message):
            continue
        meta = message.get("meta") if isinstance(message.get("meta"), dict) else {}
        if meta.get("kind") in INTERNAL_MESSAGE_KINDS:
            continue
        record = records.get(str(message.get("tool_call_id") or ""))
        events.extend(_project_message(message, meta, record, session_id))
    terminal = _terminal_event(turn_state, session_id)
    if terminal is not None:
        events.append(terminal)
    return events


def _project_message(message: dict[str, Any], meta: dict[str, Any], record: dict[str, Any] | None, session_id: str) -> list[dict[str, Any]]:
    role = message.get("role")
    turn_id = str(meta.get("turn_id") or "")
    if role == "user":
        return [{
            "type": "turn_started",
            "session_id": session_id,
            "turn_id": turn_id,
            "user_message_chars": len(str(message.get("content") or "")),
        }]
    if role == "assistant":
        events = [
            {
                "type": "tool_requested",
                "session_id": session_id,
                "turn_id": turn_id,
                "tool_call_id": str(call.get("id") or ""),
                "tool_name": str(_tool_call_field(call, "name") or ""),
                "arguments": _tool_call_arguments(call),
            }
            for call in _assistant_tool_calls(message)
            if isinstance(call, dict) and call.get("id")
        ]
        if message.get("content"):
            content = str(message.get("content") or "")
            # Live events carry `content` (see AssistantMessageCompletedEvent);
            # `text` stays as an alias so blueprint-era consumers keep working.
            events.append({
                "type": "assistant_message_completed",
                "session_id": session_id,
                "turn_id": turn_id,
                "content": content,
                "content_chars": len(content),
                "text": content,
            })
        return events
    if role == "tool":
        return [_tool_result_event(message, record, turn_id, session_id)]
    return []


def _assistant_tool_calls(message: dict[str, Any]) -> list[Any]:
    meta = message.get("meta") if isinstance(message.get("meta"), dict) else {}
    calls = meta.get("tool_calls") if isinstance(meta.get("tool_calls"), list) else message.get("tool_calls")
    return calls if isinstance(calls, list) else []


def _tool_call_field(call: dict[str, Any], name: str) -> Any:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    return call.get(name) or function.get(name)


def _tool_call_arguments(call: dict[str, Any]) -> dict[str, Any]:
    raw_args = call.get("raw_args")
    if raw_args is None:
        raw_args = _tool_call_field(call, "arguments")
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, str) and raw_args.strip():
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _tool_result_event(message: dict[str, Any], record: dict[str, Any] | None, turn_id: str, session_id: str) -> dict[str, Any]:
    record = record if isinstance(record, dict) else {}
    model_content = record.get("model_content")
    if not isinstance(model_content, str) or not model_content:
        model_content = message.get("content") if isinstance(message.get("content"), str) else ""
    event = {
        "type": "tool_result",
        "session_id": session_id,
        "turn_id": turn_id,
        "tool_call_id": str(message.get("tool_call_id") or ""),
        "result": model_content,
        "status": "error" if record.get("error_type") or record.get("ok") is False else "completed",
    }
    try:
        start = datetime.fromisoformat(str(record.get("ts_start") or ""))
        end = datetime.fromisoformat(str(record.get("ts_end") or ""))
        if end >= start:
            event["duration_ms"] = int((end - start).total_seconds() * 1000)
    except ValueError:
        pass
    return event


def _terminal_event(turn_state: dict[str, Any] | None, session_id: str) -> dict[str, Any] | None:
    state = turn_state if isinstance(turn_state, dict) else {}
    event_type = _TERMINAL_EVENT_TYPES.get(str(state.get("status") or "").strip().lower())
    if event_type is None:
        return None
    event = {"type": event_type, "session_id": session_id, "turn_id": str(state.get("turn_id") or "")}
    reason = str(state.get("reason") or state.get("error") or "")
    if event_type == "turn_failed" and reason:
        event["reason"] = reason
    return event
