"""ACP-inspired contract between a Surface and the Runtime Package."""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = "2"


class RuntimeMethod:
    INITIALIZE = "initialize"
    SHUTDOWN = "shutdown"
    SESSION_NEW = "session/new"
    SESSION_LIST = "session/list"
    SESSION_SWITCH = "session/switch"
    SESSION_REPLAY = "session/replay"
    SESSION_PROMPT = "session/prompt"
    SESSION_CANCEL = "session/cancel"
    MODEL_LIST = "model/list"
    MODEL_SET = "model/set"
    RIND_SESSION_STEER = "rind/session/steer"
    RIND_SESSION_FOLLOW_UP = "rind/session/follow_up"
    RIND_SESSION_COMPACT = "rind/session/compact"
    RIND_COMMAND_EXECUTE = "rind/command/execute"
    RIND_USER_QUESTION_RESPOND = "rind/user-question/respond"
    RIND_BACKGROUND_LIST = "rind/background/list"
    RIND_BACKGROUND_OUTPUT = "rind/background/output"
    RIND_GOAL_GET = "rind/goal/get"
    RIND_GOAL_SET = "rind/goal/set"
    RIND_GOAL_STATUS = "rind/goal/status"
    RIND_GOAL_CLEAR = "rind/goal/clear"
    SESSION_UPDATE = "session/update"


CORE_METHODS = (
    RuntimeMethod.INITIALIZE,
    RuntimeMethod.SHUTDOWN,
    RuntimeMethod.SESSION_NEW,
    RuntimeMethod.SESSION_LIST,
    RuntimeMethod.SESSION_SWITCH,
    RuntimeMethod.SESSION_REPLAY,
    RuntimeMethod.SESSION_PROMPT,
    RuntimeMethod.SESSION_CANCEL,
    RuntimeMethod.MODEL_LIST,
    RuntimeMethod.MODEL_SET,
    RuntimeMethod.RIND_SESSION_STEER,
    RuntimeMethod.RIND_SESSION_FOLLOW_UP,
    RuntimeMethod.RIND_SESSION_COMPACT,
    RuntimeMethod.RIND_COMMAND_EXECUTE,
    RuntimeMethod.RIND_USER_QUESTION_RESPOND,
)

CAPABILITIES = (
    "sessions",
    "models",
    "rind/commands",
    "rind/compaction",
    "rind/user-questions",
    "rind/steering",
    "rind/follow-up",
)

DURABLE_EVENT_TYPES = frozenset(
    {
        "turn_started",
        "assistant_message_completed",
        "tool_requested",
        "tool_result",
        "turn_completed",
        "turn_failed",
        "turn_cancelled",
    }
)


def event_durability(event: dict[str, Any]) -> str:
    return "durable" if event.get("type") in DURABLE_EVENT_TYPES else "incremental"


def event_envelope(event: dict[str, Any], sequence: int) -> dict[str, Any]:
    """Wrap a runtime event as one standardized session update."""
    return {
        "kind": "event",
        "method": RuntimeMethod.SESSION_UPDATE,
        "sequence": sequence,
        "durability": event_durability(event),
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
