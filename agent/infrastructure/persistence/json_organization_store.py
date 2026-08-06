"""JSON/JSONL persistence for the minimal organization control plane."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Iterable

from agent.application.organization.models import (
    Agent,
    AgentConfig,
    ArtifactRef,
    Delivery,
    Message,
    OrganizationEvent,
    TurnRecord,
    utc_now,
)
from agent.infrastructure.paths import resolve_rind_home
from agent.infrastructure.persistence.session_files import SessionFiles


SCHEMA_VERSION = "1.0"


def _delivery_key(message_id: str, recipient_id: str) -> tuple[str, str]:
    return (message_id, recipient_id)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class JsonOrganizationStore:
    """Persist long-lived agents and append-only organization facts."""

    def __init__(self, organization_dir: str | Path | None = None, *, workspace_root: str | Path | None = None) -> None:
        self.root = Path(organization_dir or (resolve_rind_home() / "organization")).expanduser().resolve()
        self.workspace_root = Path(workspace_root or (self.root.parent / "workspaces")).expanduser().resolve()
        self._files = SessionFiles()
        self.agent_configs: dict[str, AgentConfig] = {}
        self.agents: dict[str, Agent] = {}
        self.messages: dict[str, Message] = {}
        self.deliveries: dict[tuple[str, str], Delivery] = {}
        self.turns: list[TurnRecord] = []
        self.events: list[OrganizationEvent] = []
        self.session_projections: set[tuple[str, str]] = set()
        self._setup()
        self._load()

    @property
    def paths(self) -> dict[str, Path]:
        return {
            "agent_configs": self.root / "agent_configs.json",
            "agents": self.root / "agents.json",
            "messages": self.root / "messages.jsonl",
            "deliveries": self.root / "deliveries.jsonl",
            "turns": self.root / "turns.jsonl",
            "events": self.root / "events.jsonl",
        }

    def _setup(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        for key in ("messages", "deliveries", "turns", "events"):
            self.paths[key].touch(exist_ok=True)
        if not self.paths["agent_configs"].exists():
            self._write_configs_snapshot()
        if not self.paths["agents"].exists():
            self._write_agents_snapshot()

    def _load(self) -> None:
        configs_snapshot = self._files.load_json(str(self.paths["agent_configs"])) or {}
        agents_snapshot = self._files.load_json(str(self.paths["agents"])) or {}
        self.agent_configs = {
            config.id: config
            for config in (
                AgentConfig.from_dict(item)
                for item in configs_snapshot.get("agent_configs", [])
            )
        }
        self.agents = {
            agent.id: agent
            for agent in (
                Agent.from_dict(item)
                for item in agents_snapshot.get("agents", [])
            )
        }
        self.messages = {}
        for item in self._files.read_jsonl(str(self.paths["messages"])):
            message = Message.from_dict(item)
            self.messages[message.id] = message
        self.deliveries = {}
        for item in self._files.read_jsonl(str(self.paths["deliveries"])):
            delivery = Delivery.from_dict(item)
            self.deliveries[_delivery_key(delivery.message_id, delivery.recipient_id)] = delivery
        self.turns = [TurnRecord.from_dict(item) for item in self._files.read_jsonl(str(self.paths["turns"]))]
        self.events = [OrganizationEvent.from_dict(item) for item in self._files.read_jsonl(str(self.paths["events"]))]
        self.session_projections = {
            (event.agent_id, event.message_id)
            for event in self.events
            if event.type == "message_projected" and event.agent_id and event.message_id
        }

    def _write_configs_snapshot(self) -> None:
        payload = {
            "schema_version": SCHEMA_VERSION,
            "agent_configs": [config.to_dict() for config in sorted(self.agent_configs.values(), key=lambda item: item.id)],
        }
        self._files.write_json(str(self.paths["agent_configs"]), payload)

    def _write_agents_snapshot(self) -> None:
        payload = {
            "schema_version": SCHEMA_VERSION,
            "agents": [agent.to_dict() for agent in sorted(self.agents.values(), key=lambda item: item.id)],
        }
        self._files.write_json(str(self.paths["agents"]), payload)

    def _append_jsonl(self, key: str, data: dict) -> None:
        self._files.append_jsonl(str(self.paths[key]), data)

    def _resolve_workspace_path(self, value: str, *, field_name: str) -> Path:
        raw = Path(str(value or "")).expanduser()
        candidate = raw if raw.is_absolute() else self.workspace_root / raw
        resolved = candidate.resolve()
        if not _is_relative_to(resolved, self.workspace_root):
            raise ValueError(f"{field_name} escapes the organization workspace root.")
        return resolved

    def _validate_artifacts(self, artifacts: Iterable[ArtifactRef]) -> None:
        for artifact in artifacts:
            if artifact.kind == "path":
                self._resolve_workspace_path(artifact.value, field_name="artifact path")

    def save_agent_config(self, config: AgentConfig) -> AgentConfig:
        self.agent_configs[config.id] = config
        self._write_configs_snapshot()
        return config

    def get_agent_config(self, config_id: str) -> AgentConfig | None:
        return self.agent_configs.get(config_id)

    def list_agent_configs(self) -> list[AgentConfig]:
        return sorted(self.agent_configs.values(), key=lambda item: item.id)

    def save_agent(self, agent: Agent) -> Agent:
        if agent.config_id not in self.agent_configs:
            raise ValueError(f"Unknown agent config: {agent.config_id}")
        workspace = self._resolve_workspace_path(agent.workspace_root, field_name="workspace_root")
        workspace.mkdir(parents=True, exist_ok=True)
        normalized = replace(agent, workspace_root=str(workspace))
        self.agents[normalized.id] = normalized
        self._write_agents_snapshot()
        return normalized

    def get_agent(self, agent_id: str) -> Agent | None:
        return self.agents.get(agent_id)

    def list_agents(self) -> list[Agent]:
        return sorted(self.agents.values(), key=lambda item: item.id)

    def update_agent_status(self, agent_id: str, status: str) -> Agent:
        agent = self.require_agent(agent_id)
        updated = replace(agent, status=status, updated_at=utc_now())
        self.agents[updated.id] = updated
        self._write_agents_snapshot()
        return updated

    def require_agent(self, agent_id: str) -> Agent:
        agent = self.get_agent(agent_id)
        if agent is None:
            raise ValueError(f"Unknown agent: {agent_id}")
        return agent

    def require_config(self, config_id: str) -> AgentConfig:
        config = self.get_agent_config(config_id)
        if config is None:
            raise ValueError(f"Unknown agent config: {config_id}")
        return config

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

    def list_messages(self, *, thread_id: str | None = None, agent_id: str | None = None, limit: int | None = None) -> list[Message]:
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
        if status:
            deliveries = [delivery for delivery in deliveries if delivery.status == status]
        deliveries.sort(key=lambda item: item.updated_at)
        return deliveries

    def claim_delivery(self, message_id: str, recipient_id: str) -> Delivery | None:
        delivery = self.get_delivery(message_id, recipient_id)
        if delivery is None or delivery.status != "pending":
            return None
        claimed = replace(delivery, status="claimed", attempts=delivery.attempts + 1, updated_at=utc_now())
        self.deliveries[_delivery_key(message_id, recipient_id)] = claimed
        self._append_jsonl("deliveries", claimed.to_dict())
        return claimed

    def mark_delivery_processed(self, message_id: str, recipient_id: str) -> Delivery:
        return self._mark_delivery(message_id, recipient_id, "processed")

    def mark_delivery_failed(self, message_id: str, recipient_id: str) -> Delivery:
        return self._mark_delivery(message_id, recipient_id, "failed")

    def _mark_delivery(self, message_id: str, recipient_id: str, status: str) -> Delivery:
        delivery = self.get_delivery(message_id, recipient_id)
        if delivery is None:
            raise ValueError(f"Unknown delivery: {message_id} -> {recipient_id}")
        updated = replace(delivery, status=status, updated_at=utc_now())
        self.deliveries[_delivery_key(message_id, recipient_id)] = updated
        self._append_jsonl("deliveries", updated.to_dict())
        return updated

    def append_turn(self, turn: TurnRecord) -> TurnRecord:
        self.turns.append(turn)
        self._append_jsonl("turns", turn.to_dict())
        return turn

    def list_turns(self, *, agent_id: str | None = None, message_id: str | None = None) -> list[TurnRecord]:
        turns = list(self.turns)
        if agent_id:
            turns = [turn for turn in turns if turn.agent_id == agent_id]
        if message_id:
            turns = [turn for turn in turns if turn.message_id == message_id]
        return turns

    def append_event(self, event: OrganizationEvent) -> OrganizationEvent:
        self.events.append(event)
        if event.type == "message_projected" and event.agent_id and event.message_id:
            self.session_projections.add((event.agent_id, event.message_id))
        self._append_jsonl("events", event.to_dict())
        return event

    def list_events(self) -> list[OrganizationEvent]:
        return list(self.events)

    def record_session_projection(self, agent_id: str, message_id: str) -> bool:
        key = (agent_id, message_id)
        if key in self.session_projections:
            return False
        self.append_event(OrganizationEvent(type="message_projected", agent_id=agent_id, message_id=message_id))
        return True

    def has_session_projection(self, agent_id: str, message_id: str) -> bool:
        return (agent_id, message_id) in self.session_projections
