"""Queue-only organization operations for a manifest-defined Team."""

from __future__ import annotations

from collections.abc import Collection, Iterable
from typing import Any

from .models import ArtifactRef, Delivery, Message, OrganizationEvent, new_id


class OrganizationCoordinator:
    """Record Team messages and runtime status without starting Agent turns."""

    def __init__(self, store: Any, *, agent_ids: Collection[str]) -> None:
        self.store = store
        self._agent_ids = frozenset(str(agent_id) for agent_id in agent_ids)

    def require_agent(self, agent_id: str) -> None:
        if agent_id not in self._agent_ids:
            raise ValueError(f"Agent is not a Team member: {agent_id}")

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
        self.require_agent(recipient_id)
        if sender_id != "user":
            self.require_agent(sender_id)
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
                type="message_queued",
                agent_id=recipient_id,
                message_id=message.id,
                payload={"sender_id": sender_id, "thread_id": message.thread_id},
            )
        )
        return message

    def set_agent_status(self, agent_id: str, status: str):
        self.require_agent(agent_id)
        state = self.store.set_agent_status(agent_id, status)
        self.store.append_event(
            OrganizationEvent(type=f"agent_{status}", agent_id=agent_id)
        )
        return state
