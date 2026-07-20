"""Display-only state for CLI runtime events."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class ToolDisplayState:
    """Small status snapshot for one tool call."""

    tool_call_id: str
    name: str
    status: str = "requested"
    args_preview: str = ""
    duration_ms: int = 0
    error_type: str = ""
    last_progress: str = ""
    request_rendered: bool = False


@dataclass(slots=True)
class TurnDisplayState:
    """Small status snapshot for the current turn."""

    turn_id: str = ""
    tools: dict[str, ToolDisplayState] = field(default_factory=dict)
    activated_skills: set[str] = field(default_factory=set)
