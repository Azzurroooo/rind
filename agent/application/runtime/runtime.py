"""Facade for the asynchronous agent runtime."""

from __future__ import annotations

import asyncio
import uuid
from typing import AsyncIterator

from agent.application.ports.session_store import SessionStore
from agent.application.runtime.turn_runner import TurnRunner
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import PersistenceError
from agent.domain.events import RuntimeEvent, TurnStartedEvent, event_meta


class AgentRuntime:
    """Facade exposing asynchronous entry points for session-bound turns."""

    def __init__(self, turn_runner: TurnRunner, session_store: SessionStore):
        self._turn_runner = turn_runner
        self._session_store = session_store
        self._initialized = False
        self._initialize_lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize or load the session state. Safe to call multiple times."""
        if self._initialized:
            return
        async with self._initialize_lock:
            if self._initialized:
                return
            try:
                await self._session_store.initialize()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise PersistenceError(
                    f"Failed to initialize session store: {exc}",
                    code=type(exc).__name__,
                ) from exc
            self._initialized = True

    def set_retry_callback(self, callback) -> None:
        """Set a callback invoked on LLM API retries: (attempt: int, exception: Exception) -> None."""
        self._turn_runner.set_retry_callback(callback)

    def set_user_question_responder(self, responder) -> None:
        """Set a callback invoked when ask_user_question needs a user answer."""
        self._turn_runner.set_user_question_responder(responder)

    async def set_model(self, model: str) -> dict[str, bool]:
        """Switch the active chat model and persist the session metadata when supported."""
        await self.initialize()
        runtime_updated = bool(self._turn_runner.set_model(model))
        try:
            await self._session_store.update_model(model)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
                raise PersistenceError(
                    f"Failed to persist model update: {exc}",
                    code=type(exc).__name__,
            ) from exc
        return {"runtime": runtime_updated, "session": True}

    async def compact_context(self, reason: str = "manual", cancellation_token: CancellationToken | None = None) -> dict:
        """Manually compact the current session through the turn runner."""
        await self.initialize()
        return await self._turn_runner.compact_context(
            self._session_store,
            reason=reason,
            phase="manual",
            cancellation_token=cancellation_token,
        )

    async def run_turn(
        self,
        session_id: str | None = None,
        query: str | None = None,
        cancellation_token: CancellationToken | None = None,
        transient_system_messages: list[dict] | None = None,
    ) -> AsyncIterator[RuntimeEvent]:
        """
        Run a single conversational turn asynchronously, yielding runtime events.

        Note: session_id is accepted for API compatibility but the session bound to
        this facade at construction time is always used. The caller is responsible
        for constructing one facade per session.
        """
        await self.initialize()
        turn_id = uuid.uuid4().hex

        if query:
            try:
                await self._session_store.persist_message("user", query)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise PersistenceError(
                    f"Failed to persist user message: {exc}",
                    code=type(exc).__name__,
                ) from exc

        started_event = TurnStartedEvent(
            **event_meta(self._session_store, turn_id),
            user_message_chars=len(query or ""),
        )
        await self._persist_turn_state(started_event)
        yield started_event

        runner_kwargs = {
            "session": self._session_store,
            "cancellation_token": cancellation_token,
            "turn_id": turn_id,
        }
        if transient_system_messages:
            runner_kwargs["transient_system_messages"] = transient_system_messages

        async for event in self._turn_runner.run_turn(**runner_kwargs):
            if event.type in {"turn_completed", "turn_failed", "turn_cancelled"}:
                await self._persist_turn_state(event)
            yield event

    async def _persist_turn_state(self, event: RuntimeEvent) -> None:
        persist = getattr(self._session_store, "persist_turn_state", None)
        if not callable(persist):
            return
        try:
            status = "running" if event.type == "turn_started" else event.type.removeprefix("turn_")
            await persist(event.turn_id, status, event.ts)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise PersistenceError(
                f"Failed to persist turn state: {exc}",
                code=type(exc).__name__,
            ) from exc
