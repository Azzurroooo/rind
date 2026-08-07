"""User-scoped JSON/JSONL persistence for one manifest-defined Team."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Iterable

from agent.application.organization import (
    AgentRuntimeState,
    ArtifactRef,
    Delivery,
    Message,
    OrganizationEvent,
)
from agent.infrastructure.paths import resolve_rind_home
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.infrastructure.team import TeamProject


SCHEMA_VERSION = "1"


def _delivery_key(message_id: str, recipient_id: str) -> tuple[str, str]:
    return (message_id, recipient_id)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class JsonTeamStateStore:
    """Persist mutable Team facts without duplicating project manifests."""

    def __init__(self, project: TeamProject, *, rind_home: str | Path | None = None) -> None:
        self.project_id = project.project_id
        home = Path(rind_home).expanduser().resolve() if rind_home else resolve_rind_home()
        self.root = (home / "teams" / project.project_id).resolve()
        self.shared_root = project.shared_root.resolve()
        self._files = SessionFiles()
        self.agent_states: dict[str, AgentRuntimeState] = {}
        self.messages: dict[str, Message] = {}
        self.deliveries: dict[tuple[str, str], Delivery] = {}
        self.events: list[OrganizationEvent] = []
        self._load()

    @property
    def paths(self) -> dict[str, Path]:
        return {
            "agent_states": self.root / "agent_states.json",
            "messages": self.root / "messages.jsonl",
            "deliveries": self.root / "deliveries.jsonl",
            "events": self.root / "events.jsonl",
        }

    def _load(self) -> None:
        snapshot = self._files.load_json(str(self.paths["agent_states"])) or {}
        self.agent_states = {
            state.agent_id: state
            for state in (
                AgentRuntimeState.from_dict(item)
                for item in snapshot.get("agent_states", [])
            )
        }
        self.messages = {
            message.id: message
            for message in (Message.from_dict(item) for item in self._files.read_jsonl(str(self.paths["messages"])))
        }
        self.deliveries = {
            _delivery_key(delivery.message_id, delivery.recipient_id): delivery
            for delivery in (Delivery.from_dict(item) for item in self._files.read_jsonl(str(self.paths["deliveries"])))
        }
        self.events = [OrganizationEvent.from_dict(item) for item in self._files.read_jsonl(str(self.paths["events"]))]

    def _ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def _append_jsonl(self, key: str, data: dict) -> None:
        self._ensure_root()
        self._files.append_jsonl(str(self.paths[key]), data)

    def _write_agent_states(self) -> None:
        self._ensure_root()
        self._files.write_json(
            str(self.paths["agent_states"]),
            {
                "schema_version": SCHEMA_VERSION,
                "agent_states": [
                    state.to_dict()
                    for state in sorted(self.agent_states.values(), key=lambda item: item.agent_id)
                ],
            },
        )

    def get_agent_state(self, agent_id: str) -> AgentRuntimeState:
        return self.agent_states.get(agent_id, AgentRuntimeState(agent_id=agent_id))

    def list_agent_states(self) -> list[AgentRuntimeState]:
        return sorted(self.agent_states.values(), key=lambda item: item.agent_id)

    def set_agent_status(self, agent_id: str, status: str) -> AgentRuntimeState:
        current = self.get_agent_state(agent_id)
        updated = replace(current, status=status)
        self.agent_states[updated.agent_id] = updated
        self._write_agent_states()
        return updated

    def _validate_artifacts(self, artifacts: Iterable[ArtifactRef]) -> None:
        for artifact in artifacts:
            raw = Path(artifact.value).expanduser()
            candidate = raw if raw.is_absolute() else self.shared_root / raw
            if not _is_relative_to(candidate.resolve(), self.shared_root):
                raise ValueError(f"artifact path escapes Team shared root: {artifact.value}")

    def append_message(self, message: Message) -> Message:
        existing = self.messages.get(message.id)
        if existing is not None:
            return existing
        self._validate_artifacts(message.artifact_refs)
        self.messages[message.id] = message
        self._append_jsonl("messages", message.to_dict())
        return message

    def get_message(self, message_id: str) -> Message | None:
        return self.messages.get(message_id)

    def list_messages(
        self,
        *,
        thread_id: str | None = None,
        agent_id: str | None = None,
        limit: int | None = None,
    ) -> list[Message]:
        messages = list(self.messages.values())
        if thread_id:
            messages = [message for message in messages if message.thread_id == thread_id]
        if agent_id:
            messages = [message for message in messages if agent_id in {message.sender_id, message.recipient_id}]
        messages.sort(key=lambda item: item.created_at)
        return messages[-limit:] if limit else messages

    def append_delivery(self, delivery: Delivery) -> Delivery:
        key = _delivery_key(delivery.message_id, delivery.recipient_id)
        existing = self.deliveries.get(key)
        if existing is not None:
            return existing
        self.deliveries[key] = delivery
        self._append_jsonl("deliveries", delivery.to_dict())
        return delivery

    def get_delivery(self, message_id: str, recipient_id: str) -> Delivery | None:
        return self.deliveries.get(_delivery_key(message_id, recipient_id))

    def list_deliveries(self, *, status: str | None = None) -> list[Delivery]:
        deliveries = list(self.deliveries.values())
        if status is not None:
            deliveries = [delivery for delivery in deliveries if delivery.status == status]
        return sorted(deliveries, key=lambda item: item.updated_at)

    def append_event(self, event: OrganizationEvent) -> OrganizationEvent:
        self.events.append(event)
        self._append_jsonl("events", event.to_dict())
        return event

    def list_events(self) -> list[OrganizationEvent]:
        return list(self.events)
