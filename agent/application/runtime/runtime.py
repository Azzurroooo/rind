"""Facade for the asynchronous agent runtime."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from contextlib import asynccontextmanager
from typing import AsyncIterator

from agent.application.ports.session_store import SessionStore
from agent.application.skill_selection import SkillTurnCoordinator
from agent.application.runtime.turn_runner import TurnRunner
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import PersistenceError
from agent.domain.events import RuntimeEvent, TurnStartedEvent, event_meta
from agent.prompts import build_goal_prompt


MAX_QUEUED_INPUTS = 4
MAX_QUEUED_INPUT_CHARS = 8_000

logger = logging.getLogger(__name__)


class InputQueueError(ValueError):
    """A rejected steering or follow-up submission."""

    def __init__(self, message: str, error_type: str) -> None:
        super().__init__(message)
        self.error_type = error_type


class AgentRuntime:
    """Facade exposing asynchronous entry points for session-bound turns."""

    def __init__(
        self,
        turn_runner: TurnRunner,
        session_store: SessionStore,
        goal_enabled: bool = False,
        skill_repository=None,
        runtime_system_messages: list[dict] | None = None,
        workspace_lock=None,
    ):
        self._turn_runner = turn_runner
        self._session_store = session_store
        self._initialized = False
        self._initialize_lock = asyncio.Lock()
        self._turn_lock = asyncio.Lock()
        self._active_turn_id = ""
        self._accepting_inputs = False
        self._steering_queue: deque[str] = deque()
        self._follow_up_queue: deque[str] = deque()
        self._goal_enabled = bool(goal_enabled)
        self._skill_repository = skill_repository
        self._runtime_system_messages = tuple(dict(message) for message in (runtime_system_messages or []))
        self._workspace_lock = workspace_lock
        self._skill_turn_coordinator = (
            SkillTurnCoordinator(skill_repository) if skill_repository is not None else None
        )

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
            await self._sync_skill_catalog()
            self._sync_turn_runner_model()
            self._initialized = True

    async def _sync_skill_catalog(self) -> None:
        if self._skill_repository is None:
            return
        setter = getattr(self._session_store, "set_skill_catalog", None)
        if not callable(setter):
            return
        try:
            entries = [skill.to_catalog_entry() for skill in self._skill_repository.list_skills()]
        except Exception:
            logger.warning("Skill catalog scan failed; retaining the previous catalog.", exc_info=True)
            return
        try:
            await setter(entries)
        except Exception:
            logger.debug("Skill catalog persistence failed; retaining the previous catalog.", exc_info=True)
            return

    def _sync_turn_runner_model(self) -> str:
        model = str(getattr(self._session_store, "model", None) or "").strip()
        set_model = getattr(self._turn_runner, "set_model", None)
        if model and callable(set_model):
            set_model(model)
        return model

    def set_retry_callback(self, callback) -> None:
        """Set a callback invoked on LLM API retries: (attempt: int, exception: Exception) -> None."""
        self._turn_runner.set_retry_callback(callback)

    @property
    def skill_repository(self):
        """Expose the resolved repository to read-only interface commands."""
        return self._skill_repository

    def set_user_question_responder(self, responder) -> None:
        """Set a callback invoked when ask_user_question needs a user answer."""
        self._turn_runner.set_user_question_responder(responder)

    def submit_steering(self, text: str) -> dict[str, object]:
        return self._submit_input("steering", text, self._steering_queue)

    def submit_follow_up(self, text: str) -> dict[str, object]:
        return self._submit_input("follow_up", text, self._follow_up_queue)

    def discard_pending_inputs(self) -> None:
        self._steering_queue.clear()
        self._follow_up_queue.clear()

    def input_queue_counts(self) -> dict[str, int]:
        return {
            "steering": len(self._steering_queue),
            "follow_up": len(self._follow_up_queue),
        }

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

    async def get_goal(self) -> dict[str, str] | None:
        await self.initialize()
        if not self._goal_enabled:
            raise RuntimeError("Goal support is unavailable.")
        getter = getattr(self._session_store, "get_goal", None)
        if not callable(getter):
            raise RuntimeError("Goal support is unavailable.")
        goal = await getter()
        return dict(goal) if isinstance(goal, dict) else None

    async def set_goal(self, objective: str) -> dict[str, str]:
        await self.initialize()
        if not self._goal_enabled:
            raise RuntimeError("Goal support is unavailable.")
        if self._accepting_inputs or self._active_turn_id:
            raise RuntimeError("Cannot replace a goal while a turn is active.")
        async with self._workspace_lock_guard(), self._turn_lock:
            if self._accepting_inputs or self._active_turn_id:
                raise RuntimeError("Cannot replace a goal while a turn is active.")
            setter = getattr(self._session_store, "set_goal", None)
            if not callable(setter):
                raise RuntimeError("Goal support is unavailable.")
            goal = await setter(objective)
            return dict(goal)

    async def set_goal_status(self, status: str) -> dict[str, str]:
        await self.initialize()
        if not self._goal_enabled:
            raise RuntimeError("Goal support is unavailable.")
        setter = getattr(self._session_store, "set_goal_status", None)
        if not callable(setter):
            raise RuntimeError("Goal support is unavailable.")
        goal = await setter(status)
        return dict(goal)

    async def clear_goal(self) -> None:
        await self.initialize()
        if not self._goal_enabled:
            raise RuntimeError("Goal support is unavailable.")
        clear = getattr(self._session_store, "clear_goal", None)
        if not callable(clear):
            raise RuntimeError("Goal support is unavailable.")
        await clear()

    async def switch_session(self, session_id: str) -> dict[str, object]:
        """Rebind the runtime to an existing session while it is idle."""
        await self.initialize()
        if self._accepting_inputs or self._active_turn_id:
            raise RuntimeError("Cannot switch sessions while a turn is active.")

        async with self._turn_lock:
            if self._accepting_inputs or self._active_turn_id:
                raise RuntimeError("Cannot switch sessions while a turn is active.")
            switch = getattr(self._session_store, "switch_session", None)
            if not callable(switch):
                raise RuntimeError("Session switching is unsupported by this session store.")
            self.discard_pending_inputs()
            try:
                result = await switch(session_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise PersistenceError(
                    f"Failed to switch session: {exc}",
                    code=type(exc).__name__,
                ) from exc

            target_model = self._sync_turn_runner_model()
            self.discard_pending_inputs()
            return dict(result) if isinstance(result, dict) else {
                "session_id": getattr(self._session_store, "session_id", None),
                "model": target_model,
            }

    async def create_session(self) -> dict[str, object]:
        """Create and bind a new session while the runtime is idle."""
        await self.initialize()
        if self._accepting_inputs or self._active_turn_id:
            raise RuntimeError("Cannot create a session while a turn is active.")

        async with self._turn_lock:
            if self._accepting_inputs or self._active_turn_id:
                raise RuntimeError("Cannot create a session while a turn is active.")
            create = getattr(self._session_store, "create_session", None)
            if not callable(create):
                raise RuntimeError("Session creation is unsupported by this session store.")
            self.discard_pending_inputs()
            try:
                result = await create()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise PersistenceError(
                    f"Failed to create session: {exc}",
                    code=type(exc).__name__,
                ) from exc

            target_model = self._sync_turn_runner_model()
            self.discard_pending_inputs()
            return dict(result) if isinstance(result, dict) else {
                "session_id": getattr(self._session_store, "session_id", None),
                "model": target_model,
            }

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
        async with self._workspace_lock_guard(), self._turn_lock:
            turn_id = uuid.uuid4().hex
            self._active_turn_id = turn_id
            self._accepting_inputs = True
            self.discard_pending_inputs()
            try:
                if query:
                    await self._persist_user_input(query)

                started_event = TurnStartedEvent(
                    **event_meta(self._session_store, turn_id),
                    user_message_chars=len(query or ""),
                )
                await self._persist_turn_state(started_event)
                yield started_event

                total_duration_ms = 0
                while True:
                    runner_kwargs = {
                        "session": self._session_store,
                        "cancellation_token": cancellation_token,
                        "turn_id": turn_id,
                        "take_steering": self._take_steering,
                    }
                    context_messages = [dict(message) for message in self._runtime_system_messages]
                    context_messages.extend(dict(message) for message in (transient_system_messages or []))
                    goal = await self._current_goal()
                    if goal and goal.get("status") == "active":
                        context_messages.append(
                            {
                                "role": "system",
                                "content": build_goal_prompt(goal["objective"]),
                                "_context_kind": "goal",
                            }
                        )
                    if context_messages:
                        runner_kwargs["transient_system_messages"] = context_messages

                    terminal_event = None
                    async for event in self._turn_runner.run_turn(**runner_kwargs):
                        if event.type in {"turn_completed", "turn_failed", "turn_cancelled"}:
                            terminal_event = event
                            continue
                        yield event

                    if terminal_event is None:
                        raise RuntimeError("Turn runner ended without a terminal event.")

                    if terminal_event.type == "turn_completed":
                        total_duration_ms += int(getattr(terminal_event, "duration_ms", 0) or 0)
                    if terminal_event.type == "turn_completed" and not self._is_cancelled(cancellation_token):
                        follow_up = self._take_follow_up()
                        if follow_up is not None:
                            await self._persist_user_input(follow_up)
                            continue
                        if await self._goal_is_active():
                            continue

                    if terminal_event.type == "turn_failed":
                        await self._stop_active_goal("blocked")
                    elif terminal_event.type == "turn_cancelled":
                        await self._stop_active_goal("paused")

                    if terminal_event.type == "turn_completed":
                        terminal_event.duration_ms = total_duration_ms

                    self._accepting_inputs = False
                    self.discard_pending_inputs()
                    await self._persist_turn_state(terminal_event)
                    yield terminal_event
                    return
            finally:
                self._accepting_inputs = False
                self._active_turn_id = ""
                self.discard_pending_inputs()

    async def _current_goal(self) -> dict[str, str] | None:
        if not self._goal_enabled:
            return None
        getter = getattr(self._session_store, "get_goal", None)
        if not callable(getter):
            return None
        goal = await getter()
        return dict(goal) if isinstance(goal, dict) else None

    async def _goal_is_active(self) -> bool:
        goal = await self._current_goal()
        return bool(goal and goal.get("status") == "active")

    async def _stop_active_goal(self, status: str) -> None:
        goal = await self._current_goal()
        if not goal or goal.get("status") != "active":
            return
        setter = getattr(self._session_store, "set_goal_status", None)
        if callable(setter):
            await setter(status)

    def _submit_input(self, mode: str, text: str, queue: deque[str]) -> dict[str, object]:
        value = str(text or "").strip()
        if not self._accepting_inputs or not self._active_turn_id:
            raise InputQueueError("No active turn accepts queued input.", "TurnNotActive")
        if not value:
            raise InputQueueError(f"{mode} input must not be empty.", "InvalidRequest")
        if len(value) > MAX_QUEUED_INPUT_CHARS:
            raise InputQueueError(
                f"{mode} input exceeds {MAX_QUEUED_INPUT_CHARS} characters.",
                "InputTooLong",
            )
        if sum(map(len, queue)) + len(value) > MAX_QUEUED_INPUT_CHARS:
            raise InputQueueError(
                f"{mode} queue exceeds {MAX_QUEUED_INPUT_CHARS} queued characters.",
                "InputQueueFull",
            )
        if len(queue) >= MAX_QUEUED_INPUTS:
            raise InputQueueError(
                f"{mode} queue is full (maximum {MAX_QUEUED_INPUTS}).",
                "InputQueueFull",
            )
        queue.append(value)
        return {"accepted": True, "mode": mode, "pending": len(queue)}

    def _take_steering(self) -> str | None:
        if not self._steering_queue:
            return None
        return self._steering_queue.popleft()

    def _take_follow_up(self) -> str | None:
        if not self._follow_up_queue:
            return None
        return self._follow_up_queue.popleft()

    def _is_cancelled(self, cancellation_token: CancellationToken | None) -> bool:
        return bool(cancellation_token and cancellation_token.is_cancelled)

    @asynccontextmanager
    async def _workspace_lock_guard(self):
        if self._workspace_lock is None:
            yield
            return
        async with self._workspace_lock:
            yield

    async def _persist_user_input(self, content: str) -> None:
        if self._skill_turn_coordinator is not None:
            try:
                await self._skill_turn_coordinator.persist_user_input(self._session_store, content)
                return
            except asyncio.CancelledError:
                raise
            except ValueError:
                raise
            except Exception as exc:
                raise PersistenceError(
                    f"Failed to persist user input: {exc}",
                    code=type(exc).__name__,
                ) from exc
        await self._persist_message("user", content)

    async def _persist_message(self, role: str, content: str, meta: dict | None = None) -> None:
        try:
            if meta is None:
                await self._session_store.persist_message(role, content)
            else:
                await self._session_store.persist_message(role, content, meta=meta)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise PersistenceError(
                f"Failed to persist {role} message: {exc}",
                code=type(exc).__name__,
            ) from exc

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
