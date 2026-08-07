"""Dynamic facts recorded for a Team project's local runtime."""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal


AgentRuntimeStatus = Literal["idle", "paused"]
DeliveryStatus = Literal["pending"]


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


@dataclass(frozen=True, slots=True)
class AgentRuntimeState:
    agent_id: str
    status: AgentRuntimeStatus = "idle"
    updated_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_id", _require_text(self.agent_id, "agent_id"))
        if self.status not in {"idle", "paused"}:
            raise ValueError(f"Unsupported agent runtime status: {self.status}")
        object.__setattr__(self, "updated_at", _require_text(self.updated_at, "updated_at"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentRuntimeState":
        return cls(**dict(data))


@dataclass(frozen=True, slots=True)
class TeamMember:
    agent_id: str
    display_name: str
    workspace_root: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_id", _require_text(self.agent_id, "agent_id"))
        object.__setattr__(self, "display_name", _require_text(self.display_name, "display_name"))
        object.__setattr__(self, "workspace_root", _require_text(self.workspace_root, "workspace_root"))


@dataclass(frozen=True, slots=True)
class TeamRuntimeContext:
    project_id: str
    current_agent_id: str
    members: tuple[TeamMember, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "project_id", _require_text(self.project_id, "project_id"))
        object.__setattr__(self, "current_agent_id", _require_text(self.current_agent_id, "current_agent_id"))
        object.__setattr__(self, "members", tuple(self.members))

    def get_member(self, agent_id: str) -> TeamMember | None:
        return next((member for member in self.members if member.agent_id == agent_id), None)


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    value: str
    kind: Literal["path"] = "path"

    def __post_init__(self) -> None:
        if self.kind != "path":
            raise ValueError(f"Unsupported artifact kind: {self.kind}")
        object.__setattr__(self, "value", _require_text(self.value, "artifact value"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ArtifactRef":
        if not isinstance(data, dict):
            raise ValueError("artifact_refs entries must be objects.")
        return cls(value=data.get("value", ""), kind=data.get("kind", "path"))


def _artifact_tuple(values: tuple[ArtifactRef, ...] | list[ArtifactRef | dict[str, Any]] | None) -> tuple[ArtifactRef, ...]:
    if values is None:
        return ()
    return tuple(item if isinstance(item, ArtifactRef) else ArtifactRef.from_dict(item) for item in values)


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
    updated_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(self, "message_id", _require_text(self.message_id, "message_id"))
        object.__setattr__(self, "recipient_id", _require_text(self.recipient_id, "recipient_id"))
        if self.status != "pending":
            raise ValueError(f"Unsupported delivery status: {self.status}")
        object.__setattr__(self, "updated_at", _require_text(self.updated_at, "updated_at"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Delivery":
        return cls(**dict(data))


@dataclass(frozen=True, slots=True)
class OrganizationEvent:
    type: str
    event_id: str = field(default_factory=lambda: new_id("orgevt"))
    ts: str = field(default_factory=utc_now)
    agent_id: str = ""
    message_id: str = ""
    payload: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "type", _require_text(self.type, "event type"))
        object.__setattr__(self, "event_id", _require_text(self.event_id, "event_id"))
        object.__setattr__(self, "ts", _require_text(self.ts, "ts"))
        object.__setattr__(self, "agent_id", str(self.agent_id or ""))
        object.__setattr__(self, "message_id", str(self.message_id or ""))
        if not isinstance(self.payload, dict):
            raise ValueError("event payload must be an object.")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "OrganizationEvent":
        return cls(**dict(data))
