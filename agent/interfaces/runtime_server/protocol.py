"""Shared fields for the versioned runtime event protocol."""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = "1"
CAPABILITIES = (
    "events",
    "turns",
    "slash_commands",
    "models",
    "compaction",
    "user_questions",
)


def event_envelope(event: dict[str, Any], sequence: int) -> dict[str, Any]:
    """Wrap a runtime event without changing its domain payload."""
    return {
        "kind": "event",
        "sequence": sequence,
        "event_type": str(event.get("type") or ""),
        "timestamp": str(event.get("ts") or ""),
        "session_id": str(event.get("session_id") or ""),
        "turn_id": str(event.get("turn_id") or ""),
        "event": event,
    }


def response_message(request: dict[str, Any], result: Any) -> dict[str, Any]:
    return {"kind": "response", "request_id": request.get("request_id"), "result": result}


def error_message(request: dict[str, Any], message: str, error_type: str) -> dict[str, Any]:
    return {
        "kind": "response",
        "request_id": request.get("request_id"),
        "error": {"type": error_type, "message": message},
    }
