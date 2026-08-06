"""Small data model for the AI Organization OS message loop.

The organization layer deliberately keeps durable facts small: agents, messages,
deliveries, coarse turn records, and flat events. It does not introduce tasks,
shared discussion state, or organization memory.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
import uuid


AgentStatus = Literal["idle", "working", "paused", "archived"]
ArtifactKind = Literal["path", "hash", "event_id", "tool_call_id"]
DeliveryStatus = Literal["pending", "claimed", "processed", "failed"]
QuestionPolicy = Literal["deny", "route_to_supervisor", "allow"]
TurnStatus = Literal["started", "completed", "failed"]

AGENT_STATUSES: set[str] = {"idle", "working", "paused", "archived"}
ARTIFACT_KINDS: set[str] = {"path", "hash", "event_id", "tool_call_id"}
DELIVERY_STATUSES: set[str] = {"pending", "claimed", "processed", "failed"}
QUESTION_POLICIES: set[str] = {"deny", "route_to_supervisor", "allow"}
TURN_STATUSES: set[str] = {"started", "completed", "failed"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    value = str(prefix or "id").strip().lower().replace(" ", "_")
    return f"{value}_{uuid.uuid4().hex[:16]}"


def _require_text(value: object, field_name: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field_name} must not be empty.")
    return text


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _text_tuple(values: tuple[str, ...] | list[str] | None, field_name: str) -> tuple[str, ...]:
    if values is None:
        return ()
    result: list[str] = []
    for item in values:
        text = str(item or "").strip()
        if not text:
            raise ValueError(f"{field_name} entries must not be empty.")
        result.append(text)
    return tuple(result)


def _artifact_tuple(values: tuple["ArtifactRef", ...] | list["ArtifactRef" | dict[str, Any]] | None) -> tuple["ArtifactRef", ...]:
    if values is None:
        return ()
    artifacts: list[ArtifactRef] = []
    for item in values:
        artifacts.append(item if isinstance(item, ArtifactRef) else ArtifactRef.from_dict(item))
    return tuple(artifacts)


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    kind: ArtifactKind
    value: str

    def __post_init__(self) -> None:
        kind = _require_text(self.kind, "artifact kind")
        if kind not in ARTIFACT_KINDS:
            raise ValueError(f"Unsupported artifact kind: {kind}")
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "value", _require_text(self.value, "artifact value"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ArtifactRef":
        if not isinstance(data, dict):
            raise ValueError("artifact_refs entries must be objects.")
        return cls(kind=data.get("kind", ""), value=data.get("value", ""))


@dataclass(frozen=True, slots=True)
class AgentConfig:
    id: str
    display_name: str
    system_prompt: str
    enabled_tools: tuple[str, ...] = ()
    workspace_policy: str = "workspace_root"
    question_policy: QuestionPolicy = "route_to_supervisor"
    sop: str | None = None
    expected_artifacts: tuple[str, ...] = ()
    model: str | None = None
    reasoning_effort: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _require_text(self.id, "config id"))
        object.__setattr__(self, "display_name", _require_text(self.display_name, "config display_name"))
        object.__setattr__(self, "system_prompt", _require_text(self.system_prompt, "system_prompt"))
        object.__setattr__(self, "enabled_tools", _text_tuple(self.enabled_tools, "enabled_tools"))
        policy = _require_text(self.question_policy, "question_policy")
        if policy not in QUESTION_POLICIES:
            raise ValueError(f"Unsupported question_policy: {policy}")
        object.__setattr__(self, "question_policy", policy)
        object.__setattr__(self, "workspace_policy", _require_text(self.workspace_policy, "workspace_policy"))
        object.__setattr__(self, "sop", _optional_text(self.sop))
        object.__setattr__(self, "expected_artifacts", _text_tuple(self.expected_artifacts, "expected_artifacts"))
        object.__setattr__(self, "model", _optional_text(self.model))
        object.__setattr__(self, "reasoning_effort", _optional_text(self.reasoning_effort))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentConfig":
        return cls(**dict(data))


@dataclass(frozen=True, slots=True)
class Agent:
    id: str
    config_id: str
    display_name: str
    session_id: str
    workspace_root: str
    supervisor_id: str | None = None
    status: AgentStatus = "idle"
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _require_text(self.id, "agent id"))
        object.__setattr__(self, "config_id", _require_text(self.config_id, "config_id"))
        object.__setattr__(self, "display_name", _require_text(self.display_name, "agent display_name"))
        object.__setattr__(self, "session_id", _require_text(self.session_id, "session_id"))
        object.__setattr__(self, "workspace_root", _require_text(self.workspace_root, "workspace_root"))
        object.__setattr__(self, "supervisor_id", _optional_text(self.supervisor_id))
        status = _require_text(self.status, "agent status")
        if status not in AGENT_STATUSES:
            raise ValueError(f"Unsupported agent status: {status}")
        object.__setattr__(self, "status", status)
        object.__setattr__(self, "created_at", _require_text(self.created_at, "created_at"))
        object.__setattr__(self, "updated_at", _require_text(self.updated_at, "updated_at"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Agent":
        return cls(**dict(data))


@dataclass(frozen=True, slots=True)
class Message:
    id: str
    thread_id: str
    sender_id: str
    recipient_id: str
    body: str
    reply_to: str | None = None
    artifact_refs: tuple[ArtifactRef, ...] = ()
    created_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _require_text(self.id, "message id"))
        object.__setattr__(self, "thread_id", _require_text(self.thread_id, "thread_id"))
        object.__setattr__(self, "sender_id", _require_text(self.sender_id, "sender_id"))
        object.__setattr__(self, "recipient_id", _require_text(self.recipient_id, "recipient_id"))
        object.__setattr__(self, "body", _require_text(self.body, "body"))
        object.__setattr__(self, "reply_to", _optional_text(self.reply_to))
        object.__setattr__(self, "artifact_refs", _artifact_tuple(self.artifact_refs))
        object.__setattr__(self, "created_at", _require_text(self.created_at, "created_at"))

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["artifact_refs"] = [artifact.to_dict() for artifact in self.artifact_refs]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Message":
        payload = dict(data)
        payload["artifact_refs"] = _artifact_tuple(payload.get("artifact_refs"))
        return cls(**payload)


@dataclass(frozen=True, slots=True)
class Delivery:
    message_id: str
    recipient_id: str
    status: DeliveryStatus = "pending"
    attempts: int = 0
    updated_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(self, "message_id", _require_text(self.message_id, "message_id"))
        object.__setattr__(self, "recipient_id", _require_text(self.recipient_id, "recipient_id"))
        status = _require_text(self.status, "delivery status")
        if status not in DELIVERY_STATUSES:
            raise ValueError(f"Unsupported delivery status: {status}")
        object.__setattr__(self, "status", status)
        if int(self.attempts) < 0:
            raise ValueError("attempts must be non-negative.")
        object.__setattr__(self, "attempts", int(self.attempts))
        object.__setattr__(self, "updated_at", _require_text(self.updated_at, "updated_at"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Delivery":
        return cls(**dict(data))


@dataclass(frozen=True, slots=True)
class TurnRecord:
    turn_id: str
    agent_id: str
    message_id: str
    status: TurnStatus
    started_at: str
    completed_at: str | None = None
    error: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "turn_id", _require_text(self.turn_id, "turn_id"))
        object.__setattr__(self, "agent_id", _require_text(self.agent_id, "agent_id"))
        object.__setattr__(self, "message_id", _require_text(self.message_id, "message_id"))
        status = _require_text(self.status, "turn status")
        if status not in TURN_STATUSES:
            raise ValueError(f"Unsupported turn status: {status}")
        object.__setattr__(self, "status", status)
        object.__setattr__(self, "started_at", _require_text(self.started_at, "started_at"))
        object.__setattr__(self, "completed_at", _optional_text(self.completed_at))
        object.__setattr__(self, "error", str(self.error or ""))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TurnRecord":
        return cls(**dict(data))


@dataclass(frozen=True, slots=True)
class OrganizationEvent:
    type: str
    event_id: str = field(default_factory=lambda: new_id("orgevt"))
    ts: str = field(default_factory=utc_now)
    agent_id: str = ""
    message_id: str = ""
    turn_id: str = ""
    payload: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "type", _require_text(self.type, "event type"))
        object.__setattr__(self, "event_id", _require_text(self.event_id, "event_id"))
        object.__setattr__(self, "ts", _require_text(self.ts, "ts"))
        object.__setattr__(self, "agent_id", str(self.agent_id or ""))
        object.__setattr__(self, "message_id", str(self.message_id or ""))
        object.__setattr__(self, "turn_id", str(self.turn_id or ""))
        if not isinstance(self.payload, dict):
            raise ValueError("event payload must be an object.")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "OrganizationEvent":
        return cls(**dict(data))
