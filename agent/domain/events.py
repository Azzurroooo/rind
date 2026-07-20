"""Runtime event definitions for conversation and tool execution.

Runtime events are live transport/progress signals for CLI and API consumers.
They are serializable, but they are not the persisted source of truth for
session reconstruction; persisted messages, tool calls, compactions, and plan
control records own that responsibility.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Literal


def make_event_id() -> str:
    """Return a compact unique id for a runtime event."""
    return uuid.uuid4().hex


def event_meta(session: Any = None, turn_id: str = "") -> dict[str, str]:
    """Build common event metadata from a session-like object."""
    now_iso = getattr(session, "now_iso", None)
    try:
        ts = now_iso() if callable(now_iso) else ""
    except Exception:
        ts = ""
    if not isinstance(ts, str) or not ts:
        ts = str(time.time())
    session_id = getattr(session, "session_id", "")
    if not isinstance(session_id, str):
        session_id = ""
    return {
        "ts": ts,
        "session_id": session_id,
        "turn_id": turn_id or "",
    }


@dataclass(slots=True)
class RuntimeEvent:
    """Base class for all runtime events."""
    type: str
    ts: str = field(default_factory=lambda: str(time.time()))
    event_id: str = field(default_factory=make_event_id)
    session_id: str = ""
    turn_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Serialize event to a dictionary."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RuntimeEvent:
        """Deserialize a dictionary to a RuntimeEvent instance."""
        event_type = data.get("type")

        # We need to dispatch to the correct subclass
        for subclass in cls.__subclasses__():
            # Get the default value of 'type' field from the subclass
            if hasattr(subclass, "__dataclass_fields__") and "type" in subclass.__dataclass_fields__:
                type_field = subclass.__dataclass_fields__["type"]
                if type_field.default == event_type:
                    # Filter data to only include valid fields for this subclass
                    valid_keys = {f.name for f in subclass.__dataclass_fields__.values()}
                    filtered_data = {k: v for k, v in data.items() if k in valid_keys}
                    return subclass(**filtered_data)

        # Fallback to base class if no match
        valid_keys = {f.name for f in cls.__dataclass_fields__.values()}
        filtered_data = {k: v for k, v in data.items() if k in valid_keys}
        return cls(**filtered_data)


@dataclass(slots=True)
class AssistantDeltaEvent(RuntimeEvent):
    """Fired when a new chunk of text is received from the assistant."""
    type: Literal["assistant_delta"] = "assistant_delta"
    text: str = ""


@dataclass(slots=True)
class TurnStartedEvent(RuntimeEvent):
    """Fired when a user turn starts."""
    type: Literal["turn_started"] = "turn_started"
    user_message_chars: int = 0


@dataclass(slots=True)
class ContextBuiltEvent(RuntimeEvent):
    """Fired after model-facing context has been built."""
    type: Literal["context_built"] = "context_built"
    message_count: int = 0
    stats: dict[str, Any] = field(default_factory=dict)
    decisions: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AssistantMessageCompletedEvent(RuntimeEvent):
    """Fired when the assistant finishes generating a message."""
    type: Literal["assistant_message_completed"] = "assistant_message_completed"
    content: str = ""
    content_chars: int = 0


@dataclass(slots=True)
class ToolRequestedEvent(RuntimeEvent):
    """Fired when the model requests a tool call."""
    type: Literal["tool_requested"] = "tool_requested"
    tool_call_id: str = ""
    tool_name: str = ""
    args_preview: str = ""


@dataclass(slots=True)
class ToolCallStartedEvent(RuntimeEvent):
    """Fired when a tool execution is about to begin."""
    type: Literal["tool_call_started"] = "tool_call_started"
    tool_call_id: str = ""
    tool_name: str = ""


@dataclass(slots=True)
class UserQuestionRequestedEvent(RuntimeEvent):
    """Fired when a tool call needs a direct user answer."""
    type: Literal["user_question_requested"] = "user_question_requested"
    tool_call_id: str = ""
    question: str = ""
    options: list[str] | None = None
    recommended: str | None = None


@dataclass(slots=True)
class ToolProgressEvent(RuntimeEvent):
    """Fired when a tool produces incremental progress (e.g. streaming stdout)."""
    type: Literal["tool_progress"] = "tool_progress"
    tool_call_id: str = ""
    tool_name: str = ""
    payload: dict[str, Any] | None = None


@dataclass(slots=True)
class ToolResultEvent(RuntimeEvent):
    """Fired when a tool execution completes and returns a result."""
    type: Literal["tool_result"] = "tool_result"
    tool_call_id: str = ""
    tool_name: str = ""
    status: Literal["completed", "failed"] = "completed"
    result: str = ""
    error_type: str = ""
    duration_ms: int = 0


@dataclass(slots=True)
class FileChangeEvent(RuntimeEvent):
    """Fired when a file-writing tool completes with a displayable change."""
    type: Literal["file_change"] = "file_change"
    tool_call_id: str = ""
    file_path: str = ""
    lines: list[dict[str, str]] = field(default_factory=list)


@dataclass(slots=True)
class TokenStatsUpdatedEvent(RuntimeEvent):
    """Fired when provider token usage is available."""
    type: Literal["token_stats_updated"] = "token_stats_updated"
    stats: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SkillActivatedEvent(RuntimeEvent):
    """Fired when a skill is selected and injected into the model context."""
    type: Literal["skill_activated"] = "skill_activated"
    skill_name: str = ""
    reason: str = ""
    score: int = 0
    source: str = ""
    path: str = ""


@dataclass(slots=True)
class TurnCompletedEvent(RuntimeEvent):
    """Fired when an entire turn (including all tool executions and LLM generation) completes successfully."""
    type: Literal["turn_completed"] = "turn_completed"
    duration_ms: int = 0


@dataclass(slots=True)
class TurnFailedEvent(RuntimeEvent):
    """Fired when a turn fails due to an error."""
    type: Literal["turn_failed"] = "turn_failed"
    error: str = ""
    error_type: str = ""


@dataclass(slots=True)
class TurnCancelledEvent(RuntimeEvent):
    """Fired when a turn is cancelled (e.g. via CancellationToken)."""
    type: Literal["turn_cancelled"] = "turn_cancelled"
    reason: str = ""
