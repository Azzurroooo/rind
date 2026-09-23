"""Active execution coordination and release."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
import copy
from dataclasses import dataclass, field, replace
import inspect
import json
import tempfile
import uuid
from typing import Any

from agent.application.task_notifications import TaskNotifications, pending_notification
from agent.bootstrap import AgentContainer, SharedRuntimeResources, build_agent_container
from agent.domain.tasks import TERMINAL_STATES, public_task
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import UserQuestionRequestedEvent
from agent.domain.models import ModelSelection
from agent.infrastructure.llm import ProviderServiceImpl
from agent.infrastructure.paths import validate_session_id, validate_workspace_root
from agent.infrastructure.settings import load_settings
from agent.infrastructure.tools.shell.tool import ShellTools
from agent.infrastructure.tools.web.session_pool import WebSessions
from agent.prompts import build_goal_checkpoint_prompt
from agent.runtime.server.session_service import SessionService


@dataclass(slots=True)
class _ActiveExecution:
    container: AgentContainer
    turn_slot: asyncio.Lock = field(default_factory=asyncio.Lock)
    current_cancel: CancellationTokenSource | None = None
    pending_answers: dict[str, asyncio.Future[str]] = field(default_factory=dict)
    queued_turn_starts: int = 0


@dataclass(slots=True)
class _RequestScope:
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    answer: str = ""
    error: str = ""


class ExecutionCoordinator:
    """Create and release session execution objects only while work is active."""

    def __init__(
        self,
        *,
        shared_resources: SharedRuntimeResources,
        shell_tools: ShellTools,
        web_sessions: WebSessions,
        repository: SessionService,
        debug: bool,
        enable_goal: bool,
        enable_user_question: bool,
        session_dir: str | None,
        provider_service: ProviderServiceImpl,
    ):
        self._shared_resources = shared_resources
        self._shell_tools = shell_tools
        self._web_sessions = web_sessions
        self._repository = repository
        self._debug = debug
        self._enable_goal = enable_goal
        self._enable_user_question = enable_user_question
        self.session_dir = session_dir
        self._active: dict[str, _ActiveExecution] = {}
        self._starting: dict[str, asyncio.Task] = {}
        self._live: dict[str, dict[str, Any]] = {}
        self._continuations: dict[str, asyncio.Task] = {}
        self._suppressed: set[str] = set()
        self._pending_wakes: set[str] = set()
        self._scopes: dict[str, _RequestScope] = {}
        self._task_events: dict[str, dict] = {}
        self._task_resync_sessions: set[str] = set()
        self._task_event_pump: asyncio.Task | None = None
        self._task_notifications = TaskNotifications(shell_tools.supervisor.journal, self.task_changed,
            lambda sid: self._scopes[sid].request_id if sid in self._scopes else None)
        shell_tools.supervisor.set_observer(self.task_changed)
        self._event_sinks: list[Callable[[dict[str, Any]], Awaitable[None] | None]] = []
        self._closed = False
        self._closed_sessions: set[str] = set()
        self._provider_service = provider_service
        self._lock = asyncio.Lock()

    def add_event_sink(self, sink: Callable[[dict[str, Any]], Awaitable[None] | None]) -> Callable[[], None]:
        """Register an event sink and return a callable that unregisters it."""
        self._event_sinks.append(sink)

        def remove() -> None:
            try:
                self._event_sinks.remove(sink)
            except ValueError:
                pass

        return remove

    async def _emit_to_event_sinks(self, event: dict[str, Any]) -> None:
        for sink in list(self._event_sinks):
            try:
                sink_result = sink(event)
                if inspect.isawaitable(sink_result):
                    await sink_result
            except Exception:
                if sink in self._event_sinks:
                    self._event_sinks.remove(sink)

    def task_changed(self, snapshot: dict) -> None:
        if self._closed:
            return
        session_id = snapshot["owner_session_id"]
        event_type = snapshot.get("type", "task_updated")
        key = f"{snapshot['task_id']}:{event_type}"
        if snapshot.get("status") in TERMINAL_STATES:
            self._task_events.pop(f"{snapshot['task_id']}:task_output", None)
        self._queue_task_event(key, {"type": event_type, "session_id": session_id, "turn_id": "",
            "origin_turn_id": snapshot.get("origin_turn_id", ""), "task": public_task(snapshot)})
        scope = self._scopes.get(session_id)
        if scope:
            scope.changed.set()
        if pending_notification(snapshot):
            self._schedule_continuation(session_id)

    async def background_wait(self, session_id: str) -> dict | None:
        records = await self._task_notifications.store.records(session_id)
        goal = await self._repository.get_goal(session_id) if self._enable_goal else None
        if self._closed or session_id in self._suppressed or session_id in self._closed_sessions:
            return None
        if goal and goal.get("status") in {"paused", "blocked", "budget_exhausted"}:
            return None
        scope = self._scopes.get(session_id)
        tasks = [record for record in records.values()
                 if record.get("notify") == "on_exit" and record.get("status") == "running"
                 and record.get("committed") and record.get("handoff")
                 and record.get("worker_instance_id") == self._shell_tools.supervisor.journal.worker_instance_id
                 and (scope is None or record.get("request_id") == scope.request_id)]
        if not tasks:
            return None
        return {"count": len(tasks), "started_at": min(record["started_at"] for record in tasks)}

    def refresh_background_wait(self, session_id: str) -> None:
        if self._closed:
            return
        self._queue_task_event(f"{session_id}:background_wait_changed", {
            "type": "background_wait_changed", "session_id": session_id, "turn_id": ""})

    def _queue_task_event(self, key: str, event: dict) -> None:
        if len(self._task_events) >= 128 and key not in self._task_events:
            oldest = next((item for item in self._task_events if item.endswith(":task_output")), next(iter(self._task_events)))
            dropped = self._task_events.pop(oldest)
            if dropped["type"] != "task_output":
                self._task_resync_sessions.add(dropped["session_id"])
        self._task_events[key] = event
        if self._task_event_pump is None:
            self._task_event_pump = asyncio.create_task(self._publish_task_events())

    async def _publish_task_events(self) -> None:
        try:
            while self._task_events or self._task_resync_sessions:
                if self._task_events:
                    event = self._task_events.pop(next(iter(self._task_events)))
                    if event["type"] == "background_wait_changed":
                        event["background_wait"] = await self.background_wait(event["session_id"])
                    await self._emit_to_event_sinks(event)
                    if event["type"] == "task_updated":
                        self.refresh_background_wait(event["session_id"])
                else:
                    session_id = self._task_resync_sessions.pop()
                    records = await self._task_notifications.store.records(session_id)
                    for record in records.values():
                        await self._emit_to_event_sinks({"type": "task_updated", "session_id": session_id,
                            "turn_id": "", "origin_turn_id": record.get("origin_turn_id", ""), "task": public_task(record)})
                    self.refresh_background_wait(session_id)
        finally:
            self._task_event_pump = None

    def _schedule_continuation(self, session_id: str) -> bool:
        if self._closed or session_id in self._suppressed or session_id in self._closed_sessions:
            return False
        self._pending_wakes.add(session_id)
        if session_id in self._continuations:
            return False
        task = asyncio.create_task(self._run_continuation(session_id), name=f"rind-continuation-{session_id}")
        self._continuations[session_id] = task
        return True

    async def start_goal_continuation(self, session_id: str) -> bool:
        clean = validate_session_id(session_id)
        self.refresh_background_wait(clean)
        return self._schedule_continuation(clean)

    async def _run_continuation(self, session_id: str) -> None:
        try:
            await asyncio.sleep(0)
            while not self._closed and session_id not in self._suppressed:
                self._pending_wakes.discard(session_id)
                active = self._active.get(session_id)
                if active and (active.queued_turn_starts or active.container.runtime.turn_active):
                    return
                records = await self._task_notifications.store.records(session_id)
                scope = self._scopes.get(session_id)
                relevant = [r for r in records.values() if scope is None or r.get("request_id") == scope.request_id]
                pending = any(pending_notification(r) for r in relevant)
                waiting = any(r.get("notify") == "on_exit" and r["status"] not in TERMINAL_STATES for r in relevant)
                goal = await self._repository.get_goal(session_id) if self._enable_goal else None
                if goal and goal.get("status") in {"paused", "blocked", "budget_exhausted"}:
                    if scope:
                        scope.error = f"Goal does not allow continuation ({goal.get('status')})."
                    return
                if not pending and (waiting or not goal or goal.get("status") != "active"):
                    return
                active = self._active.get(session_id)
                if active and (active.queued_turn_starts or active.container.runtime.turn_active):
                    return
                terminal = ""
                async for event in self.run_turn(session_id, query=None, continuation=True,
                    checkpoint=str(goal["objective"]) if not pending and goal else None):
                    terminal = str(event.get("type") or terminal)
                if not terminal:
                    return
                if terminal != "turn_completed":
                    self._suppressed.add(session_id)
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._suppressed.add(session_id)
            self.refresh_background_wait(session_id)
            scope = self._scopes.get(session_id)
            if scope:
                scope.error = str(exc)
            await self._emit_to_event_sinks({"type": "task_continuation_failed", "session_id": session_id,
                "turn_id": "", "error": str(exc)})
        finally:
            self._continuations.pop(session_id, None)
            scope = self._scopes.get(session_id)
            if scope:
                scope.changed.set()
            if session_id in self._pending_wakes:
                self._pending_wakes.discard(session_id)
                self._schedule_continuation(session_id)

    def begin_request(self, session_id: str) -> str:
        clean = validate_session_id(session_id)
        if clean in self._scopes:
            raise RuntimeError("A request is already active for this session.")
        self._suppressed.discard(clean)
        scope = _RequestScope()
        self._scopes[clean] = scope
        return scope.request_id

    async def wait_request(self, session_id: str) -> dict:
        scope = self._scopes[session_id]
        try:
            while True:
                scope.changed.clear()
                if self._closed or session_id in self._suppressed or scope.error:
                    raise RuntimeError(scope.error or "Request interrupted.")
                records = await self._task_notifications.store.records(session_id)
                relevant = [r for r in records.values() if r.get("request_id") == scope.request_id]
                waiting = any((r.get("notify") == "on_exit" and r["status"] not in TERMINAL_STATES)
                              or pending_notification(r) for r in relevant)
                active = self._active.get(session_id)
                busy = active and (active.queued_turn_starts or active.container.runtime.turn_active)
                if not waiting and not busy and session_id not in self._continuations:
                    return {"request_id": scope.request_id, "answer": scope.answer}
                await scope.changed.wait()
        finally:
            self._scopes.pop(session_id, None)

    def abandon_request(self, session_id: str) -> None:
        self.interrupt(session_id, "Request disconnected")
        self._scopes.pop(session_id, None)

    def active_session_ids(self) -> set[str]:
        return set(self._active)

    def active_container(self, session_id: str) -> AgentContainer | None:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        return execution.container if execution is not None else None

    def active_turn_id(self, session_id: str) -> str:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        if execution is None:
            return ""
        return str(execution.container.runtime.active_turn_id or "")

    def live_turn(self, session_id: str) -> dict[str, Any] | None:
        clean = validate_session_id(session_id)
        snapshot = self._live.get(clean)
        return _copy_live_turn(snapshot) if snapshot is not None else None

    def record_live_input(self, session_id: str, result: dict[str, Any]) -> None:
        clean = validate_session_id(session_id)
        snapshot = self._live.get(clean)
        input_id = str(result.get("input_id") or "").strip()
        if snapshot is None or not input_id:
            return
        pending = snapshot["pending_inputs"]
        if any(item.get("input_id") == input_id for item in pending):
            return
        pending.append({
            "input_id": input_id,
            "input": str(result.get("input") or ""),
            "mode": "steering" if result.get("mode") == "steering" else "follow_up",
        })

    def update_live_event(self, event: dict[str, Any]) -> None:
        session_id = str(event.get("session_id") or "").strip()
        turn_id = str(event.get("turn_id") or "").strip()
        event_type = str(event.get("type") or "")
        if not session_id or not turn_id:
            return
        current = self._live.get(session_id)
        if event_type == "turn_started" or current is None or current["turn_id"] != turn_id:
            if event_type != "turn_started":
                return
            current = _new_live_turn(turn_id)
            self._live[session_id] = current
        if event_type == "assistant_delta":
            current["assistant_text"] = _bounded_live_text(current["assistant_text"] + str(event.get("text") or ""))
        elif event_type == "turn_step_retry":
            current["assistant_text"] = ""
        elif event_type == "assistant_message_completed":
            current["assistant_text"] = ""
        elif event_type == "tool_requested":
            tool = _live_tool(current, event)
            tool.update({
                "tool_name": str(event.get("tool_name") or ""),
                "args_preview": _bounded_live_text(str(event.get("args_preview") or ""), 120),
                "arguments": event.get("arguments") if isinstance(event.get("arguments"), dict) else {},
                "status": "pending",
            })
        elif event_type == "tool_input_started":
            tool = _live_tool(current, event)
            tool.update({"tool_name": str(event.get("tool_name") or ""), "status": "pending"})
        elif event_type == "tool_input_delta":
            tool = _live_tool(current, event)
            tool["args_preview"] = _bounded_live_text(str(tool.get("args_preview") or "") + str(event.get("delta") or ""), 120)
        elif event_type == "tool_call_started":
            _live_tool(current, event)["status"] = "running"
        elif event_type == "tool_progress":
            tool = _live_tool(current, event)
            payload = event.get("payload")
            progress = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False) if payload is not None else ""
            tool["output"] = _bounded_live_text(str(tool.get("output") or "") + progress)
        elif event_type == "tool_result":
            tool = _live_tool(current, event)
            result = str(event.get("result") or "")
            result_status = str(event.get("status") or "")
            tool.update({
                "status": "error" if event.get("error_type") or result_status in {"error", "failed"} else "completed",
                "output": _bounded_live_text(result),
                "error_type": str(event.get("error_type") or ""),
                "duration_ms": int(event.get("duration_ms") or 0),
            })
            question = current.get("question")
            if isinstance(question, dict) and question.get("tool_call_id") == tool.get("tool_call_id"):
                current["question"] = None
        elif event_type == "plan_updated":
            current["plan"] = event.get("plan") if isinstance(event.get("plan"), list) else []
        elif event_type == "user_question_requested":
            current["question"] = {
                "tool_call_id": str(event.get("tool_call_id") or ""),
                "question": str(event.get("question") or ""),
                "options": event.get("options") if isinstance(event.get("options"), list) else [],
            }
        elif event_type == "queued_input_delivered":
            input_id = str(event.get("input_id") or "")
            current["pending_inputs"] = [item for item in current["pending_inputs"] if item.get("input_id") != input_id]
        elif event_type == "file_change":
            file_path = str(event.get("file_path") or "")
            if file_path and file_path not in current["files"]:
                current["files"].append(file_path)
        elif event_type == "token_stats_updated":
            stats = event.get("stats")
            if isinstance(stats, dict) and isinstance(stats.get("context_usage_percent"), (int, float)):
                current["context_usage_percent"] = stats["context_usage_percent"]
        elif event_type in {"turn_completed", "turn_failed", "turn_cancelled"}:
            current["status"] = event_type.removeprefix("turn_")
            current["question"] = None

    async def run_turn(
        self,
        session_id: str,
        *,
        query: str | None,
        transient_system_messages: list[dict[str, Any]] | None = None,
        cancellation_token=None,
        resume: bool = False,
        continuation: bool = False,
        compact: bool = False,
        checkpoint: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        clean = validate_session_id(session_id)
        if not continuation and not compact:
            self._suppressed.discard(clean)
        await self.start(clean)
        execution = self._active[clean]
        if compact and (execution.queued_turn_starts or execution.container.runtime.turn_active):
            raise RuntimeError("Cannot compact context while a turn is active.")
        execution.queued_turn_starts += 1
        terminal_type = ""
        business_started = not compact
        try:
            async with execution.turn_slot:
                if self._closed or clean in self._suppressed or (continuation and execution.queued_turn_starts > 1):
                    return
                if continuation:
                    records = await self._task_notifications.store.records(clean)
                    scope = self._scopes.get(clean)
                    pending = any(pending_notification(r) for r in records.values()
                                  if scope is None or r.get("request_id") == scope.request_id)
                    goal = await self._repository.get_goal(clean) if self._enable_goal else None
                    if execution.queued_turn_starts > 1 or clean in self._suppressed:
                        return
                    if goal and goal.get("status") in {"paused", "blocked", "budget_exhausted"}:
                        return
                    if not pending and (not checkpoint or not goal or goal.get("status") != "active"):
                        return
                if checkpoint:
                    await execution.container.session_store.persist_message("user", build_goal_checkpoint_prompt(checkpoint), meta={"kind": "goal_checkpoint"})
                cancel_source = CancellationTokenSource(parent_token=cancellation_token)
                execution.current_cancel = cancel_source
                execution.container.runtime.set_user_question_responder(
                    lambda event: self._answer_user_question(clean, event)
                )
                try:
                    run_kwargs: dict[str, Any] = {
                        "query": query,
                        "cancellation_token": cancel_source.token,
                        "transient_system_messages": transient_system_messages,
                    }
                    if resume:
                        run_kwargs["resume"] = True
                    if compact:
                        run_kwargs["compact"] = "manual"
                    async for event in execution.container.runtime.run_turn(**run_kwargs):
                        event_data = event.to_dict()
                        if event_data.get("type") == "queued_input_delivered":
                            business_started = True
                        if event_data.get("type") in {"turn_completed", "turn_failed", "turn_cancelled"}:
                            terminal_type = str(event_data["type"])
                        scope = self._scopes.get(clean)
                        if scope and event_data.get("type") == "assistant_message_completed":
                            scope.answer = str(event_data.get("content") or "")
                        if event_data.get("type") in {"turn_failed", "turn_cancelled"}:
                            self._suppressed.add(clean)
                            await self._task_notifications.continuation_failed(clean,
                                str(event_data.get("error") or event_data.get("reason") or "Request failed."))
                            if scope:
                                scope.error = str(event_data.get("error") or event_data.get("reason") or "Request failed.")
                        if event_data.get("type") == "turn_completed":
                            event_data["background_wait"] = await self.background_wait(clean)
                        self.update_live_event(event_data)
                        if event_data.get("type") == "user_question_requested":
                            self._prepare_user_question(clean, str(event_data.get("tool_call_id") or ""))
                        if continuation:
                            await self._emit_to_event_sinks(event_data)
                        yield event_data
                finally:
                    if execution.current_cancel is cancel_source:
                        execution.current_cancel = None
                    cancel_source.dispose()
        finally:
            execution.queued_turn_starts = max(0, execution.queued_turn_starts - 1)
            await self._release_if_idle(clean, execution)
            scope = self._scopes.get(clean)
            if scope:
                scope.changed.set()
            if not continuation and business_started and terminal_type == "turn_completed":
                await self.start_goal_continuation(clean)

    async def compact_context(self, session_id: str) -> dict[str, Any]:
        record = None
        failure = None
        async for event in self.run_turn(session_id, query=None, compact=True):
            await self._emit_to_event_sinks(event)
            if event["type"] == "context_compacted" and event["record"].get("reason", "manual") == "manual":
                record = event["record"]
            elif event["type"] in {"turn_failed", "turn_cancelled"}:
                failure = event.get("error") or event.get("reason") or "Compaction cancelled."
        if record is None:
            raise RuntimeError(failure or "Compaction did not complete.")
        return record

    def interrupt(self, session_id: str, reason: str = "User interrupted") -> bool:
        clean = validate_session_id(session_id)
        self._suppressed.add(clean)
        self.refresh_background_wait(clean)
        scope = self._scopes.get(clean)
        if scope:
            scope.error = reason
            scope.changed.set()
        execution = self._active.get(clean)
        if execution is None:
            return True
        interrupted = True
        execution.container.runtime.discard_pending_inputs()
        if execution.current_cancel is not None and not execution.current_cancel.token.is_cancelled:
            execution.current_cancel.cancel(reason)
            interrupted = True
        for future in execution.pending_answers.values():
            if not future.done():
                future.set_result("")
                interrupted = True
        execution.pending_answers.clear()
        return interrupted

    def submit_input(self, session_id: str, mode: str, text: str) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        if execution is None:
            raise RuntimeError("Session execution is not active.")
        submit = (
            execution.container.runtime.submit_steering
            if mode == "steering"
            else execution.container.runtime.submit_follow_up
        )
        result = submit(text)
        self._shell_tools.supervisor.release_wait(clean)
        if isinstance(result, dict):
            self.record_live_input(clean, {**result, "session_id": clean, "mode": mode})
        return result

    def retrieve_input(self, session_id: str, mode: str, input_id: str | None = None) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        if execution is None:
            raise RuntimeError("Session execution is not active.")
        retrieve = (
            execution.container.runtime.unsteer
            if mode == "steering"
            else execution.container.runtime.dequeue_follow_up
        )
        return retrieve(input_id)

    def promote_follow_up(self, session_id: str, input_id: str) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        if execution is None:
            raise RuntimeError("Session execution is not active.")
        return execution.container.runtime.promote_follow_up(input_id)

    async def answer_user_question(self, session_id: str, tool_call_id: str, answer: str) -> None:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        if execution is None:
            raise LookupError("No pending user question.")
        future = execution.pending_answers.get(tool_call_id)
        if future is None:
            raise LookupError("No pending user question.")
        if not future.done():
            future.set_result(answer)
        snapshot = self._live.get(clean)
        question = snapshot.get("question") if isinstance(snapshot, dict) else None
        if isinstance(question, dict) and question.get("tool_call_id") == tool_call_id:
            snapshot["question"] = None

    def _prepare_user_question(self, session_id: str, tool_call_id: str) -> None:
        value = str(tool_call_id or "").strip()
        if not value:
            return
        execution = self._active.get(validate_session_id(session_id))
        if execution is not None and value not in execution.pending_answers:
            execution.pending_answers[value] = asyncio.get_running_loop().create_future()

    async def _answer_user_question(self, session_id: str, event: UserQuestionRequestedEvent) -> str:
        execution = self._active.get(session_id)
        if execution is None:
            return ""
        future = execution.pending_answers.get(event.tool_call_id)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            execution.pending_answers[event.tool_call_id] = future
        try:
            return await future
        finally:
            execution.pending_answers.pop(event.tool_call_id, None)

    async def start(self, session_id: str) -> AgentContainer:
        return await self.start_with_options(session_id)

    async def start_with_options(
        self,
        session_id: str,
        *,
        enable_user_question: bool | None = None,
        enabled_tools=None,
        lock_workspace: bool = True,
    ) -> AgentContainer:
        clean = validate_session_id(session_id)
        async with self._lock:
            existing = self._active.get(clean)
            if existing is not None:
                return existing.container
            if self._closed or clean in self._closed_sessions:
                raise RuntimeError("Worker is shutting down.")
            task = self._starting.get(clean)
            if task is None:
                task = asyncio.create_task(self._build_execution(clean, enable_user_question, enabled_tools, lock_workspace))
                self._starting[clean] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self._starting.get(clean) is task:
                self._starting.pop(clean)

    async def _build_execution(self, clean, enable_user_question, enabled_tools, lock_workspace):
        metadata = await self._repository.metadata(clean)
        root = validate_workspace_root(str(metadata.get("workspace_root") or metadata.get("cwd") or ""))
        settings = await asyncio.to_thread(load_settings, root)
        selection = ModelSelection(
            str(metadata.get("provider") or settings.provider),
            str(metadata.get("model") or settings.model),
            str(metadata.get("reasoning_effort") or settings.reasoning_effort),
        )
        try:
            chat_client = await self._provider_service.create_chat_client(settings, selection, workspace_root=root)
        except Exception as exc:
            if getattr(exc, "code", "") != "provider_not_configured":
                raise
            chat_client = self._provider_service.unavailable_client(selection, str(exc))
        container = None
        try:
            container = build_agent_container(
                settings=replace(
                    settings,
                    provider=selection.provider_id,
                    model=selection.model_id,
                    reasoning_effort=selection.reasoning_effort,
                ),
                chat_client=chat_client,
                image_input=self._provider_service.resolve_selection(root, selection, settings=settings).image_input,
                session_dir=self.session_dir,
                session_id=clean,
                session_store=self._repository.draft_store(clean),
                enable_goal=self._enable_goal,
                enable_user_question=(
                    self._enable_user_question if enable_user_question is None else enable_user_question
                ),
                enabled_tools=enabled_tools,
                lock_workspace=lock_workspace,
                workspace_root=root,
                project_id=metadata.get("project_id"),
                owner_agent_id=metadata.get("owner_agent_id"),
                session_type=metadata.get("session_type"),
                parent_session_id=metadata.get("parent_session_id"),
                shared_resources=self._shared_resources,
                shell_tools=self._shell_tools,
                web_sessions=self._web_sessions,
                session_runner=self._run_delegated_session,
                task_notifications=self._task_notifications,
            )
            await container.runtime.initialize()
        except BaseException:
            await chat_client.close()
            raise
        if self._closed or clean in self._closed_sessions:
            await _close_container(container)
            raise RuntimeError("Worker is shutting down.")
        self._active[clean] = _ActiveExecution(container=container)
        return container

    async def _run_delegated_session(
        self,
        *,
        target,
        project,
        parent_session_id: str | None,
        task: str,
        instruction: str,
        cancellation_token,
        persistent: bool,
        enabled_tools=None,
    ) -> tuple[dict[str, str], str | None]:
        if persistent:
            info = await self._repository.create(
                str(target.workspace_root),
                project_id=project.project_id,
                owner_agent_id=target.agent_id,
                session_type="delegated_task",
                parent_session_id=parent_session_id,
            )
            session_id = str(info["session_id"])
            await self.start_with_options(
                session_id,
                enable_user_question=False,
                lock_workspace=False,
            )
            return await self._collect_delegated_turn(session_id, task, instruction, cancellation_token), session_id

        with tempfile.TemporaryDirectory(prefix="rind-inspect-") as session_dir:
            settings = await asyncio.to_thread(load_settings, str(target.workspace_root))
            selection = ModelSelection(settings.provider, settings.model, settings.reasoning_effort)
            try:
                chat_client = await self._provider_service.create_chat_client(settings, selection, workspace_root=str(target.workspace_root))
            except Exception as exc:
                if getattr(exc, "code", "") != "provider_not_configured":
                    raise
                chat_client = self._provider_service.unavailable_client(selection, str(exc))
            container = None
            try:
                container = build_agent_container(
                    settings=settings,
                    chat_client=chat_client,
                    image_input=self._provider_service.resolve_selection(str(target.workspace_root), selection, settings=settings).image_input,
                    session_dir=session_dir,
                    enable_goal=False,
                    enable_user_question=False,
                    enabled_tools=enabled_tools,
                    lock_workspace=False,
                    workspace_root=str(target.workspace_root),
                    project_id=project.project_id,
                    owner_agent_id=target.agent_id,
                    session_type="inspect",
                    shared_resources=self._shared_resources,
                    web_sessions=self._web_sessions,
                )
                response = await self._collect_container_turn(
                    container,
                    task,
                    instruction,
                    cancellation_token,
                )
            finally:
                try:
                    if container is not None:
                        await container.shell_tools.close()
                finally:
                    await chat_client.close()
        return response, None

    async def _collect_delegated_turn(self, session_id: str, task: str, instruction: str, cancellation_token) -> dict[str, str]:
        return await self._collect_events(
            self.run_turn(
                session_id,
                query=task,
                transient_system_messages=[{"role": "system", "content": instruction, "_context_kind": "delegate"}],
                cancellation_token=cancellation_token,
            )
        )

    async def _collect_container_turn(self, container, task: str, instruction: str, cancellation_token) -> dict[str, str]:
        return await self._collect_events(
            container.runtime.run_turn(
                query=task,
                cancellation_token=cancellation_token,
                transient_system_messages=[{"role": "system", "content": instruction, "_context_kind": "delegate"}],
            )
        )

    async def _collect_events(self, events) -> dict[str, str]:
        text = ""
        terminal: dict[str, str] | None = None
        async for event in events:
            event_data = event.to_dict() if hasattr(event, "to_dict") else event
            event_type = str(event_data.get("type") or "")
            if event_type == "assistant_message_completed":
                text = str(event_data.get("content") or "")
            elif event_type == "turn_cancelled":
                terminal = {"error": str(event_data.get("reason") or "cancelled"), "error_type": "Cancelled"}
            elif event_type == "turn_failed":
                terminal = {
                    "error": str(event_data.get("error") or "Delegated turn failed."),
                    "error_type": str(event_data.get("error_type") or "DelegatedTurnFailed"),
                }
        if terminal is not None:
            return terminal
        return {"content": text}

    async def _release_if_idle(self, session_id: str, execution: _ActiveExecution) -> None:
        if execution.current_cancel is not None or execution.queued_turn_starts or execution.container.runtime.turn_active:
            return
        released = None
        async with self._lock:
            if self._active.get(session_id) is execution:
                self._active.pop(session_id, None)
                self._live.pop(session_id, None)
                released = execution
        if released is not None:
            self._repository.release_persisted_draft()
            self._shell_tools.pool.close(session_id)
            await _close_container(released.container)

    async def release(self, session_id: str, *, permanent: bool = False) -> None:
        clean = validate_session_id(session_id)
        if permanent:
            self._closed_sessions.add(clean)
        starting = self._starting.get(clean)
        if starting:
            await asyncio.gather(asyncio.shield(starting), return_exceptions=True)
        released = None
        async with self._lock:
            execution = self._active.get(clean)
            if execution is not None:
                self.interrupt(clean, "Execution released")
                self._active.pop(clean, None)
                self._live.pop(clean, None)
                released = execution
        if released is not None:
            self._repository.release_persisted_draft()
            self._shell_tools.pool.close(session_id)
            await _close_container(released.container)

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            goal_tasks = list(self._continuations.values())
            self._shell_tools.supervisor.set_observer(None)
        if self._starting:
            await asyncio.gather(*self._starting.values(), return_exceptions=True)
            self._starting.clear()
        for task in goal_tasks:
            task.cancel()
        if goal_tasks:
            await asyncio.gather(*goal_tasks, return_exceptions=True)
        self._continuations.clear()
        if self._task_event_pump:
            self._task_event_pump.cancel()
            await asyncio.gather(self._task_event_pump, return_exceptions=True)
        self._task_events.clear()
        self._task_resync_sessions.clear()
        for scope in self._scopes.values():
            scope.error = "Worker shutting down."
            scope.changed.set()
        executions = []
        async with self._lock:
            executions = list(self._active.values())
            for session_id in list(self._active):
                self.interrupt(session_id, "Worker shutting down")
            self._active.clear()
            self._live.clear()
        if executions:
            await asyncio.gather(*(_close_container(item.container) for item in executions))
        self._repository.release_persisted_draft()
        self._event_sinks.clear()


async def _close_container(container: AgentContainer) -> None:
    await container.chat_client.close()


def _new_live_turn(turn_id: str) -> dict[str, Any]:
    return {
        "turn_id": turn_id,
        "status": "running",
        "assistant_text": "",
        "tools": {},
        "question": None,
        "pending_inputs": [],
        "plan": None,
        "files": [],
        "context_usage_percent": None,
    }


def _live_tool(snapshot: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    tool_call_id = str(event.get("tool_call_id") or "").strip()
    if not tool_call_id:
        return {}
    return snapshot["tools"].setdefault(tool_call_id, {"tool_call_id": tool_call_id, "status": "pending", "output": ""})


def _copy_live_turn(snapshot: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(snapshot)
    result["tools"] = list(result["tools"].values())
    return result


def _bounded_live_text(value: str, limit: int = 30_000) -> str:
    return value if len(value) <= limit else f"{value[:limit]}\n\n[Output truncated]"
