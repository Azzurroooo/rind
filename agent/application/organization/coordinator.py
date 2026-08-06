"""Deterministic coordinator for the minimal AI Organization OS loop."""

from __future__ import annotations

import inspect
from dataclasses import replace
from typing import Any, Awaitable, Callable, Iterable

from agent.domain.events import AssistantDeltaEvent, AssistantMessageCompletedEvent, TurnFailedEvent

from .models import (
    Agent,
    AgentConfig,
    ArtifactRef,
    Delivery,
    Message,
    OrganizationEvent,
    TurnRecord,
    new_id,
    utc_now,
)


MessageHandler = Callable[["OrganizationMessageContext"], Any | Awaitable[Any]]
ContainerBuilder = Callable[..., Any]


def _delivery_key(message_id: str, recipient_id: str) -> tuple[str, str]:
    return (message_id, recipient_id)


class InMemoryOrganizationStore:
    """Small in-memory store used to prove message delivery semantics."""

    def __init__(self) -> None:
        self.agent_configs: dict[str, AgentConfig] = {}
        self.agents: dict[str, Agent] = {}
        self.messages: dict[str, Message] = {}
        self.deliveries: dict[tuple[str, str], Delivery] = {}
        self.turns: list[TurnRecord] = []
        self.events: list[OrganizationEvent] = []
        self.session_projections: set[tuple[str, str]] = set()

    def save_agent_config(self, config: AgentConfig) -> AgentConfig:
        self.agent_configs[config.id] = config
        return config

    def get_agent_config(self, config_id: str) -> AgentConfig | None:
        return self.agent_configs.get(config_id)

    def list_agent_configs(self) -> list[AgentConfig]:
        return sorted(self.agent_configs.values(), key=lambda item: item.id)

    def save_agent(self, agent: Agent) -> Agent:
        self.agents[agent.id] = agent
        return agent

    def get_agent(self, agent_id: str) -> Agent | None:
        return self.agents.get(agent_id)

    def list_agents(self) -> list[Agent]:
        return sorted(self.agents.values(), key=lambda item: item.id)

    def update_agent_status(self, agent_id: str, status: str) -> Agent:
        agent = self.require_agent(agent_id)
        updated = replace(agent, status=status, updated_at=utc_now())
        self.save_agent(updated)
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
        self.messages[message.id] = message
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
        return updated

    def append_turn(self, turn: TurnRecord) -> TurnRecord:
        self.turns.append(turn)
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
        return event

    def list_events(self) -> list[OrganizationEvent]:
        return list(self.events)

    def record_session_projection(self, agent_id: str, message_id: str) -> bool:
        key = (agent_id, message_id)
        if key in self.session_projections:
            return False
        self.session_projections.add(key)
        self.append_event(
            OrganizationEvent(
                type="message_projected",
                agent_id=agent_id,
                message_id=message_id,
            )
        )
        return True

    def has_session_projection(self, agent_id: str, message_id: str) -> bool:
        return (agent_id, message_id) in self.session_projections


class OrganizationMessageContext:
    """Context passed to deterministic worker handlers."""

    def __init__(
        self,
        *,
        coordinator: "OrganizationCoordinator",
        agent: Agent,
        config: AgentConfig,
        message: Message,
        depth: int,
    ) -> None:
        self.coordinator = coordinator
        self.agent = agent
        self.config = config
        self.message = message
        self.depth = depth

    async def reply(self, body: str, artifact_refs: Iterable[ArtifactRef | dict[str, Any]] = ()) -> Message:
        return await self.coordinator.send_message(
            sender_id=self.agent.id,
            recipient_id=self.message.sender_id,
            body=body,
            thread_id=self.message.thread_id,
            reply_to=self.message.id,
            artifact_refs=artifact_refs,
        )

    async def send(self, recipient_id: str, body: str, artifact_refs: Iterable[ArtifactRef | dict[str, Any]] = ()) -> Message:
        return await self.coordinator.send_message(
            sender_id=self.agent.id,
            recipient_id=recipient_id,
            body=body,
            thread_id=self.message.thread_id,
            reply_to=self.message.id,
            artifact_refs=artifact_refs,
        )


class OrganizationCoordinator:
    """Claim pending messages, wake one agent turn, and record coarse outcomes."""

    def __init__(
        self,
        store: Any,
        *,
        worker_handlers: dict[str, MessageHandler] | None = None,
        container_builder: ContainerBuilder | None = None,
        container_builder_kwargs: dict[str, Any] | None = None,
        session_dir: str | None = None,
        max_reply_depth: int = 8,
    ) -> None:
        self.store = store
        self._worker_handlers = dict(worker_handlers or {})
        self._container_builder = container_builder
        self._container_builder_kwargs = dict(container_builder_kwargs or {})
        self._session_dir = session_dir
        self._max_reply_depth = max(1, int(max_reply_depth))

    def register_worker(self, agent_id: str, handler: MessageHandler) -> None:
        self._worker_handlers[agent_id] = handler

    async def send_message(
        self,
        *,
        sender_id: str,
        recipient_id: str,
        body: str,
        thread_id: str | None = None,
        reply_to: str | None = None,
        artifact_refs: Iterable[ArtifactRef | dict[str, Any]] = (),
        message_id: str | None = None,
    ) -> Message:
        self.store.require_agent(recipient_id)
        if sender_id != "user":
            self.store.require_agent(sender_id)
        if reply_to and not thread_id:
            parent = self.store.get_message(reply_to)
            if parent is None:
                raise ValueError(f"Unknown reply_to message: {reply_to}")
            thread_id = parent.thread_id
        message = Message(
            id=message_id or new_id("msg"),
            thread_id=thread_id or new_id("thread"),
            sender_id=sender_id,
            recipient_id=recipient_id,
            reply_to=reply_to,
            body=body,
            artifact_refs=tuple(
                item if isinstance(item, ArtifactRef) else ArtifactRef.from_dict(item)
                for item in artifact_refs
            ),
        )
        self.store.append_message(message)
        self.store.append_delivery(Delivery(message_id=message.id, recipient_id=recipient_id))
        self.store.append_event(
            OrganizationEvent(
                type="message_created",
                agent_id=recipient_id,
                message_id=message.id,
                payload={"sender_id": sender_id, "thread_id": message.thread_id},
            )
        )
        return message

    async def dispatch_pending(self, *, max_messages: int | None = None) -> int:
        limit = self._max_reply_depth if max_messages is None else max(1, int(max_messages))
        processed = 0
        while processed < limit:
            if not await self.dispatch_next_pending(depth=processed):
                break
            processed += 1
        return processed

    async def dispatch_next_pending(self, *, depth: int = 0) -> bool:
        for delivery in self.store.list_deliveries(status="pending"):
            agent = self.store.require_agent(delivery.recipient_id)
            if agent.status in {"paused", "archived", "working"}:
                continue
            claimed = self.store.claim_delivery(delivery.message_id, delivery.recipient_id)
            if claimed is None:
                continue
            await self._process_claimed_delivery(claimed, depth=depth)
            return True
        return False

    async def _process_claimed_delivery(self, delivery: Delivery, *, depth: int) -> None:
        agent = self.store.require_agent(delivery.recipient_id)
        config = self.store.require_config(agent.config_id)
        message = self.store.get_message(delivery.message_id)
        if message is None:
            self.store.mark_delivery_failed(delivery.message_id, delivery.recipient_id)
            return

        self.store.append_event(
            OrganizationEvent(type="message_claimed", agent_id=agent.id, message_id=message.id)
        )
        if not self.store.record_session_projection(agent.id, message.id):
            self.store.mark_delivery_processed(message.id, agent.id)
            self.store.append_event(
                OrganizationEvent(type="message_processed", agent_id=agent.id, message_id=message.id)
            )
            return

        turn = TurnRecord(
            turn_id=new_id("orgturn"),
            agent_id=agent.id,
            message_id=message.id,
            status="started",
            started_at=utc_now(),
        )
        self.store.append_turn(turn)
        self.store.append_event(
            OrganizationEvent(type="turn_started", agent_id=agent.id, message_id=message.id, turn_id=turn.turn_id)
        )
        self.store.update_agent_status(agent.id, "working")
        try:
            await self._run_agent_turn(agent=agent, config=config, message=message, depth=depth)
        except Exception as exc:
            error = str(exc)
            self.store.append_turn(
                replace(turn, status="failed", completed_at=utc_now(), error=error)
            )
            self.store.mark_delivery_failed(message.id, agent.id)
            self.store.append_event(
                OrganizationEvent(
                    type="message_failed",
                    agent_id=agent.id,
                    message_id=message.id,
                    turn_id=turn.turn_id,
                    payload={"error": error, "error_type": type(exc).__name__},
                )
            )
        else:
            self.store.append_turn(replace(turn, status="completed", completed_at=utc_now()))
            self.store.mark_delivery_processed(message.id, agent.id)
            self.store.append_event(
                OrganizationEvent(type="message_processed", agent_id=agent.id, message_id=message.id, turn_id=turn.turn_id)
            )
        finally:
            latest = self.store.require_agent(agent.id)
            if latest.status == "working":
                self.store.update_agent_status(agent.id, "idle")

    async def _run_agent_turn(self, *, agent: Agent, config: AgentConfig, message: Message, depth: int) -> None:
        handler = self._worker_handlers.get(agent.id)
        if handler is not None:
            context = OrganizationMessageContext(
                coordinator=self,
                agent=agent,
                config=config,
                message=message,
                depth=depth,
            )
            result = handler(context)
            if inspect.isawaitable(result):
                await result
            return
        await self._run_runtime_turn(agent=agent, config=config, message=message)

    async def _run_runtime_turn(self, *, agent: Agent, config: AgentConfig, message: Message) -> None:
        if self._container_builder is None:
            raise RuntimeError("container_builder is required for runtime-backed organization agents.")
        builder = self._container_builder
        container = builder(
            **self._container_builder_kwargs,
            session_id=agent.session_id,
            session_dir=self._session_dir,
            enabled_tools=config.enabled_tools or None,
            enable_user_question=config.question_policy == "allow",
        )
        transient_system_messages = [
            {
                "role": "system",
                "content": self._profile_prompt(config),
                "_context_kind": "organization_agent_profile",
            }
        ]
        content_parts: list[str] = []
        async for event in container.runtime.run_turn(
            query=self._message_projection(message),
            transient_system_messages=transient_system_messages,
        ):
            event_data = event.to_dict()
            if isinstance(event, AssistantDeltaEvent):
                content_parts.append(event.text)
            elif isinstance(event, AssistantMessageCompletedEvent) and event.content:
                content_parts = [event.content]
            elif isinstance(event, TurnFailedEvent):
                raise RuntimeError(event.error or "Runtime turn failed.")
            self.store.append_event(
                OrganizationEvent(
                    type=f"runtime_{event.type}",
                    agent_id=agent.id,
                    message_id=message.id,
                    turn_id=str(event_data.get("turn_id") or ""),
                    payload={"event_id": event_data.get("event_id", "")},
                )
            )
        response = "".join(content_parts).strip()
        if response and agent.supervisor_id:
            await self.send_message(
                sender_id=agent.id,
                recipient_id=agent.supervisor_id,
                body=response,
                thread_id=message.thread_id,
                reply_to=message.id,
            )

    def _profile_prompt(self, config: AgentConfig) -> str:
        parts = [config.system_prompt.strip()]
        if config.sop:
            parts.append(f"SOP:\n{config.sop.strip()}")
        if config.expected_artifacts:
            parts.append("Expected artifacts: " + ", ".join(config.expected_artifacts))
        if config.question_policy != "allow":
            parts.append("Do not ask the user directly. Send a message to your supervisor when user judgment is required.")
        return "\n\n".join(parts)

    def _message_projection(self, message: Message) -> str:
        artifact_lines = "\n".join(f"- {item.kind}: {item.value}" for item in message.artifact_refs) or "- none"
        return (
            "Organization message received.\n"
            f"message_id: {message.id}\n"
            f"thread_id: {message.thread_id}\n"
            f"from: {message.sender_id}\n"
            f"reply_to: {message.reply_to or ''}\n"
            "artifact_refs:\n"
            f"{artifact_lines}\n\n"
            f"body:\n{message.body}"
        )
