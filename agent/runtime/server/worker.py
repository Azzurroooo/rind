"""Long-lived worker services and active turn execution lifecycle."""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
import tempfile
import uuid
from datetime import datetime
from dataclasses import dataclass, field
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from agent.application.context import CompactionService
from agent.application.tools import ToolResultNormalizer
from agent.bootstrap import AgentContainer, SharedRuntimeResources, build_agent_container
from agent.infrastructure.config import AppSettings
from agent.infrastructure.llm import OpenAIClientFactory
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.paths import validate_session_id
from agent.infrastructure.planning import build_plan_snapshot
from agent.infrastructure.team import discover_agent
from agent.prompts import build_system_prompt
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import AssistantMessageCompletedEvent, TurnCancelledEvent, TurnFailedEvent, UserQuestionRequestedEvent
from agent.runtime.core import MessageStreamParser


@dataclass(slots=True)
class _ActiveExecution:
    container: AgentContainer
    turn_slot: asyncio.Lock = field(default_factory=asyncio.Lock)
    current_cancel: CancellationTokenSource | None = None
    pending_answers: dict[str, asyncio.Future[str]] = field(default_factory=dict)
    queued_turn_starts: int = 0


class SessionRepository:
    """Read and write persisted sessions by explicit session ID."""

    def __init__(self, *, settings: AppSettings, session_dir: str | None):
        self._settings = settings
        self.session_dir = session_dir

    async def metadata(self, session_id: str) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        return await asyncio.to_thread(JsonlSessionStore.load_session_metadata, clean, self.session_dir)

    async def list(self, limit: int = 20, workspace_root: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            JsonlSessionStore.list_session_metadata,
            self.session_dir,
            limit,
            workspace_root,
        )

    async def create(
        self,
        workspace_root: str,
        *,
        project_id: str | None = None,
        owner_agent_id: str | None = None,
        session_type: str | None = None,
        parent_session_id: str | None = None,
    ) -> dict[str, Any]:
        root = _normalize_workspace_root(workspace_root)
        agent_context = discover_agent(root)
        if project_id is None and agent_context:
            project_id = agent_context.project_id
        if owner_agent_id is None and agent_context:
            owner_agent_id = agent_context.agent_id
        if session_type is None and agent_context:
            session_type = "direct_agent_chat"
        system_prompt = build_system_prompt(root)
        agent_prompt = agent_context.capsule.system_prompt.strip() if agent_context else ""
        if agent_prompt:
            system_prompt = f"{system_prompt}\n\n{agent_prompt}"
        store = JsonlSessionStore(
            session_dir=self.session_dir,
            session_id=_new_session_id(),
            model=self._settings.model,
            system_prompt=system_prompt,
            workspace_root=root,
            project_id=project_id,
            owner_agent_id=owner_agent_id,
            session_type=session_type,
            parent_session_id=parent_session_id,
        )
        await store.initialize()
        return {
            "session_id": store.session_id,
            "draft": False,
            "model": store.model,
            "workspace_root": root,
            "turn_state": None,
        }

    async def initial(
        self,
        workspace_root: str,
        session_id: str | None = None,
        resume_latest: bool = False,
    ) -> dict[str, Any]:
        if session_id:
            return await self.info(session_id)
        if resume_latest:
            sessions = await self.list(limit=1, workspace_root=workspace_root)
            if not sessions:
                raise ValueError("No existing session found to resume.")
            return await self.info(str(sessions[0]["id"]))
        return await self.create(workspace_root)

    async def info(self, session_id: str) -> dict[str, Any]:
        meta = await self.metadata(session_id)
        return {
            "session_id": str(meta.get("session_id") or session_id),
            "draft": False,
            "model": str(meta.get("model") or self._settings.model),
            "workspace_root": str(meta.get("workspace_root") or meta.get("cwd") or ""),
            "project_id": meta.get("project_id"),
            "owner_agent_id": meta.get("owner_agent_id"),
            "session_type": meta.get("session_type"),
            "parent_session_id": meta.get("parent_session_id"),
            "turn_state": meta.get("turn_state") if isinstance(meta.get("turn_state"), dict) else None,
            "goal": meta.get("goal") if isinstance(meta.get("goal"), dict) else None,
            "usage": meta.get("latest_sampling_usage") if isinstance(meta.get("latest_sampling_usage"), dict) else None,
            "message_count": int(meta.get("message_count") or 0),
        }

    async def replay(self, session_id: str, start: int | None = None, end: int | None = None) -> dict[str, Any]:
        info = await self.info(session_id)
        store = await self._open_store_from_info(
            session_id,
            info,
            persist_system_prompt=False,
        )
        messages = await store.get_messages_slice(start=start, end=end, include_ids=True)
        return {
            "messages": messages,
            "turn_state": await store.get_turn_state(),
            "session_id": session_id,
            "model": store.model,
        }

    async def open_store(
        self,
        session_id: str,
        workspace_root: str | None = None,
        *,
        persist_system_prompt: bool = True,
    ):
        clean = validate_session_id(session_id)
        info = await self.info(clean)
        return await self._open_store_from_info(
            clean,
            info,
            workspace_root=workspace_root,
            persist_system_prompt=persist_system_prompt,
        )

    async def _open_store_from_info(
        self,
        session_id: str,
        info: dict[str, Any],
        *,
        workspace_root: str | None = None,
        persist_system_prompt: bool = True,
    ):
        clean = validate_session_id(session_id)
        root = _normalize_workspace_root(workspace_root or info["workspace_root"])
        store = JsonlSessionStore(
            session_dir=self.session_dir,
            session_id=clean,
            model=info["model"],
            system_prompt=build_system_prompt(root),
            workspace_root=root,
        )
        await store.initialize(persist_system_prompt=persist_system_prompt)
        return store

    async def get_goal(self, session_id: str) -> dict[str, str] | None:
        store = await self.open_store(session_id, persist_system_prompt=False)
        return await store.get_goal()

    async def set_goal(self, session_id: str, objective: str) -> dict[str, str]:
        store = await self.open_store(session_id)
        return await store.set_goal(objective)

    async def set_goal_status(self, session_id: str, status: str) -> dict[str, str]:
        store = await self.open_store(session_id)
        return await store.set_goal_status(status)

    async def clear_goal(self, session_id: str) -> None:
        store = await self.open_store(session_id)
        await store.clear_goal()


class ExecutionCoordinator:
    """Create and release session execution objects only while work is active."""

    def __init__(
        self,
        *,
        settings: AppSettings,
        provider_client_factory: OpenAIClientFactory,
        shared_resources: SharedRuntimeResources,
        repository: SessionRepository,
        debug: bool,
        enable_goal: bool,
        session_dir: str | None,
    ):
        self._settings = settings
        self._provider_client_factory = provider_client_factory
        self._shared_resources = shared_resources
        self._repository = repository
        self._debug = debug
        self._enable_goal = enable_goal
        self.session_dir = session_dir
        self._active: dict[str, _ActiveExecution] = {}
        self._live: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

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
        return str(getattr(execution.container.runtime, "active_turn_id", "") or "")

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
        query: str,
        transient_system_messages: list[dict[str, Any]] | None = None,
        cancellation_token=None,
        resume: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        clean = validate_session_id(session_id)
        await self.start(clean)
        execution = self._active[clean]
        execution.queued_turn_starts += 1
        try:
            async with execution.turn_slot:
                cancel_source = CancellationTokenSource(parent_token=cancellation_token)
                execution.current_cancel = cancel_source
                responder = getattr(execution.container.runtime, "set_user_question_responder", None)
                if callable(responder):
                    responder(lambda event: self._answer_user_question(clean, event))
                try:
                    run_kwargs: dict[str, Any] = {
                        "query": query,
                        "cancellation_token": cancel_source.token,
                        "transient_system_messages": transient_system_messages,
                    }
                    if resume:
                        run_kwargs["resume"] = True
                    async for event in execution.container.runtime.run_turn(**run_kwargs):
                        event_data = event.to_dict()
                        self.update_live_event(event_data)
                        yield event_data
                finally:
                    if execution.current_cancel is cancel_source:
                        execution.current_cancel = None
                    cancel_source.dispose()
        finally:
            execution.queued_turn_starts = max(0, execution.queued_turn_starts - 1)
            await self._release_if_idle(clean, execution)

    def interrupt(self, session_id: str, reason: str = "User interrupted") -> bool:
        clean = validate_session_id(session_id)
        execution = self._active.get(clean)
        if execution is None:
            return False
        interrupted = False
        discard_inputs = getattr(execution.container.runtime, "discard_pending_inputs", None)
        if callable(discard_inputs):
            discard_inputs()
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
        future = execution.pending_answers.pop(tool_call_id, None)
        if future is None:
            raise LookupError("No pending user question.")
        if not future.done():
            future.set_result(answer)

    async def _answer_user_question(self, session_id: str, event: UserQuestionRequestedEvent) -> str:
        execution = self._active.get(session_id)
        if execution is None:
            return ""
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
        enable_user_question: bool = True,
        enabled_tools=None,
        lock_workspace: bool = True,
    ) -> AgentContainer:
        clean = validate_session_id(session_id)
        async with self._lock:
            existing = self._active.get(clean)
            if existing is not None:
                return existing.container
            info = await self._repository.info(clean)
            root = _normalize_workspace_root(info["workspace_root"])
            container = build_agent_container(
                settings=self._settings,
                provider_client_factory=self._provider_client_factory,
                debug=self._debug,
                session_dir=self.session_dir,
                session_id=clean,
                enable_goal=self._enable_goal,
                enable_user_question=enable_user_question,
                enabled_tools=enabled_tools,
                lock_workspace=lock_workspace,
                workspace_root=root,
                project_id=info.get("project_id"),
                owner_agent_id=info.get("owner_agent_id"),
                session_type=info.get("session_type"),
                parent_session_id=info.get("parent_session_id"),
                shared_resources=self._shared_resources,
                session_runner=self._run_delegated_session,
            )
            await container.runtime.initialize()
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

        from agent.bootstrap import build_agent_container
        from agent.infrastructure.planning.store import preserve_active_session_context

        with tempfile.TemporaryDirectory(prefix="rind-inspect-") as session_dir:
            with preserve_active_session_context():
                container = build_agent_container(
                    settings=self._settings,
                    provider_client_factory=self._provider_client_factory,
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
                )
                response = await self._collect_container_turn(
                    container,
                    task,
                    instruction,
                    cancellation_token,
                )
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
        async with self._lock:
            if self._active.get(session_id) is execution:
                self._active.pop(session_id, None)
                self._live.pop(session_id, None)

    async def release(self, session_id: str) -> None:
        clean = validate_session_id(session_id)
        async with self._lock:
            execution = self._active.get(clean)
            if execution is not None:
                self.interrupt(clean, "Execution released")
                self._active.pop(clean, None)
                self._live.pop(clean, None)

    async def close(self) -> None:
        async with self._lock:
            for session_id in list(self._active):
                self.interrupt(session_id, "Worker shutting down")
            self._active.clear()
            self._live.clear()


class RuntimeWorker:
    """Application-scoped worker with persistent session access and active turns."""

    def __init__(
        self,
        *,
        settings: AppSettings,
        workspace_root: str,
        session_id: str | None = None,
        resume_latest: bool = False,
        session_dir: str | None = None,
        debug: bool = False,
        enable_goal: bool = True,
    ):
        self.workspace_root = _normalize_workspace_root(workspace_root)
        self.session_id = session_id
        self._resume_latest = resume_latest
        self._settings = settings
        self._provider_client_factory = OpenAIClientFactory(settings)
        provider_async_client = self._provider_client_factory.create_async_client()
        self._shared_resources = SharedRuntimeResources(
            provider_async_client=provider_async_client,
            tool_result_normalizer=ToolResultNormalizer(),
            stream_parser=MessageStreamParser(),
            compaction_service=CompactionService(plan_snapshot_provider=build_plan_snapshot),
        )
        self.repository = SessionRepository(settings=settings, session_dir=session_dir)
        self.execution = ExecutionCoordinator(
            settings=settings,
            provider_client_factory=self._provider_client_factory,
            shared_resources=self._shared_resources,
            repository=self.repository,
            debug=debug,
            enable_goal=enable_goal,
            session_dir=session_dir,
        )
        self._provider_async_client = provider_async_client
        self._initialized = False

    @property
    def default_model(self) -> str:
        return self._settings.model

    @property
    def provider_client_factory(self) -> OpenAIClientFactory:
        return self._provider_client_factory

    @property
    def model_client(self):
        return self._provider_async_client

    async def initialize(self) -> dict[str, Any]:
        if not self._initialized:
            info = await self.repository.initial(
                self.workspace_root,
                self.session_id,
                self._resume_latest,
            )
            self.session_id = str(info["session_id"])
            self._initialized = True
        info = await self.repository.info(self.session_id)
        info["live_turn"] = self.execution.live_turn(self.session_id)
        return info

    async def session(self, session_id: str) -> dict[str, Any]:
        info = await self.repository.info(session_id)
        info["live_turn"] = self.execution.live_turn(session_id)
        return info

    async def create_session(self, workspace_root: str | None = None) -> dict[str, Any]:
        return await self.repository.create(workspace_root or self.workspace_root)

    async def start_execution(self, session_id: str) -> AgentContainer:
        return await self.execution.start(session_id)

    async def release_execution(self, session_id: str) -> None:
        await self.execution.release(session_id)

    async def replay(self, session_id: str, start: int | None = None, end: int | None = None) -> dict[str, Any]:
        result = await self.repository.replay(session_id, start=start, end=end)
        result["live_turn"] = self.execution.live_turn(session_id)
        return result

    async def close(self) -> None:
        await self.execution.close()
        close = getattr(self._provider_async_client, "close", None)
        if callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result


def _normalize_workspace_root(value: str) -> str:
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace directory does not exist: {root}")
    return os.path.normcase(str(root))


def _new_session_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


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
