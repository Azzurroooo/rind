"""Shared client request processing, independent of the transport."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import copy
import inspect
from typing import Any
import uuid

from agent.infrastructure.paths import validate_session_id
from agent.runtime.core import InputQueueError
from agent.runtime.server.commands import SlashCommandContext, SlashCommandResult, SlashCommandRouter
from agent.runtime.server.commands.catalog import build_command_infos
from agent.runtime.server.protocol import (
    CAPABILITIES,
    CORE_METHODS,
    PROTOCOL_VERSION,
    RuntimeMethod,
    SESSION_SCOPED_METHODS,
    TURN_SCOPED_METHODS,
    error_message,
    event_envelope,
    response_message,
)
from agent.runtime.server.replay_events import iter_durable_events
from agent.runtime.server.resume_preview import render_resume_preview
from agent.runtime.server.workspace_files import FileMethodError, file_list, file_read, file_write
from agent.version import __version__


def protocol_capabilities(background_enabled: bool, goal_enabled: bool) -> list[str]:
    capabilities = list(CAPABILITIES)
    if background_enabled:
        capabilities.append("rind/backgrounds")
    if goal_enabled:
        capabilities.append("rind/goals")
    return capabilities


def protocol_methods(background_enabled: bool, goal_enabled: bool) -> list[str]:
    methods = list(CORE_METHODS)
    if background_enabled:
        methods.extend((RuntimeMethod.RIND_BACKGROUND_LIST, RuntimeMethod.RIND_BACKGROUND_OUTPUT))
    if goal_enabled:
        methods.extend(
            (
                RuntimeMethod.RIND_GOAL_GET,
                RuntimeMethod.RIND_GOAL_SET,
                RuntimeMethod.RIND_GOAL_STATUS,
                RuntimeMethod.RIND_GOAL_CLEAR,
            )
        )
    return methods


def slash_command_infos(router: SlashCommandRouter) -> list[dict[str, Any]]:
    return [
        {"name": info.name, "description": info.description, "usage": info.usage, "aliases": list(info.aliases)}
        for info in router.command_infos()
    ]


def background_enabled(background_list, background_output) -> bool:
    return background_list is not None and background_output is not None


async def background_list_response(background_list, session_id: str) -> dict[str, Any]:
    tasks = background_list(session_id)
    if inspect.isawaitable(tasks):
        tasks = await tasks
    if not isinstance(tasks, list):
        raise TypeError("Background list must be a list.")
    return {"tasks": tasks}


async def background_output_response(background_output, session_id: str, params: dict[str, Any]) -> dict[str, Any]:
    bg_id = params.get("bg_id")
    if not isinstance(bg_id, str) or not bg_id.strip():
        raise ValueError("rind/background/output requires bg_id.")
    max_output_chars = params.get("max_output_chars", 20000)
    if isinstance(max_output_chars, bool) or not isinstance(max_output_chars, int):
        raise ValueError("rind/background/output max_output_chars must be an integer.")
    task = background_output(
        bg_id.strip(),
        max_output_chars=max_output_chars,
        _session_id=session_id,
    )
    if inspect.isawaitable(task):
        task = await task
    if not isinstance(task, dict):
        raise TypeError("Background output must be an object.")
    return {"task": task}


class _EventWriter:
    def __init__(self, writer: Any) -> None:
        self._writer = writer
        self._lock = asyncio.Lock()
        self._sequence = 0

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            if payload.get("kind") == "event":
                self._sequence += 1
                payload = {**payload, "sequence": self._sequence}
            await self._writer.send(payload)

    def close(self) -> None:
        close = getattr(self._writer, "close", None)
        if callable(close):
            close()


class _ProtocolAuthInteraction:
    def __init__(self, server: RuntimeDispatcher) -> None:
        self._server = server

    async def prompt(self, kind: str, message: str, options=None) -> str:
        request_id = f"auth-{uuid.uuid4().hex}"
        future = asyncio.get_running_loop().create_future()
        self._server._auth_waiters[request_id] = future
        await self._server._writer.send({
            "kind": "request",
            "request_id": request_id,
            "method": RuntimeMethod.RIND_AUTH_PROMPT,
            "params": {"kind": kind, "message": message, "options": list(options or [])},
        })
        try:
            return await future
        finally:
            self._server._auth_waiters.pop(request_id, None)

    def notify(self, event: dict) -> None:
        asyncio.create_task(self._server._writer.send({
            "kind": "event",
            "method": RuntimeMethod.RIND_AUTH_UPDATE,
            "event": dict(event),
        }))


class _RepositoryGoalOps:
    """Runtime-shaped goal operations backed by the repository for inactive sessions."""

    def __init__(self, repository, session_id: str):
        self._repository = repository
        self._session_id = session_id

    async def get_goal(self):
        return await self._repository.get_goal(self._session_id)

    async def set_goal(self, objective: str):
        return await self._repository.set_goal(self._session_id, objective)

    async def set_goal_status(self, status: str):
        return await self._repository.set_goal_status(self._session_id, status)

    async def clear_goal(self):
        await self._repository.clear_goal(self._session_id)


class RuntimeDispatcher:
    """Transport-independent requests, subscriptions and responses for one connection."""


    def __init__(
        self,
        worker,
        debug: bool = False,
        *,
        background_list: Callable[[str], Any] | None = None,
        background_output: Callable[..., Any] | None = None,
        goal_enabled: bool = True,
        writer: Any,
    ):
        self._worker = worker
        self._debug = debug
        self._background_list = background_list
        self._background_output = background_output
        self._goal_enabled = goal_enabled
        self._writer = _EventWriter(writer)
        self._slash_router = SlashCommandRouter(build_command_infos())
        self._requests: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._dispatch_tasks: set[asyncio.Task] = set()
        self._initialized = False
        self._stopping = False
        self._shutdown_request: dict[str, Any] | None = None
        self._shutdown_response_sent = False
        self._subscribed: set[str] = set()
        self._auth_waiters: dict[str, asyncio.Future[str]] = {}
        self._remove_event_sink: Callable[[], None] | None = self._worker.execution.add_event_sink(self._send_event)

    def close(self) -> None:
        """Unregister this connection's sink and close the writer."""
        for future in self._auth_waiters.values():
            if not future.done():
                future.cancel()
        self._auth_waiters.clear()
        remover = self._remove_event_sink
        self._remove_event_sink = None
        if remover is not None:
            remover()
        self._writer.close()


    async def submit(self, request: dict[str, Any] | None) -> None:
        await self._requests.put(request)

    async def dispatch(self, request: dict[str, Any]) -> None:
        await self._dispatch(request)

    def schedule(self, request: dict[str, Any]) -> None:
        self._schedule_dispatch(request)


    async def serve(self) -> int:
        while True:
            request = await self._requests.get()
            if request is None:
                if not self._stopping:
                    self._stopping = True
                    for session_id in self._worker.execution.active_session_ids():
                        self._worker.execution.interrupt(session_id, "Worker shutting down")
                await self._drain_dispatch_tasks()
                await self._worker.close()
                await self._respond_to_shutdown()
                return 0
            if str(request.get("method") or "") == RuntimeMethod.SHUTDOWN:
                if not self._begin_shutdown(request):
                    await self._respond_error(request, "Runtime is shutting down.", "ServerStopping")
                continue
            if self._stopping:
                await self._respond_error(request, "Runtime is shutting down.", "ServerStopping")
                continue
            if request.get("method") == RuntimeMethod.INITIALIZE:
                await self._dispatch(request)
            else:
                self._schedule_dispatch(request)

    def _schedule_dispatch(self, request: dict[str, Any]) -> None:
        task = asyncio.create_task(self._dispatch(request))
        self._dispatch_tasks.add(task)
        task.add_done_callback(self._dispatch_tasks.discard)

    async def _cancel_dispatch_tasks(self) -> None:
        for task in self._dispatch_tasks:
            task.cancel()
        if self._dispatch_tasks:
            await asyncio.gather(*self._dispatch_tasks, return_exceptions=True)

    async def _drain_dispatch_tasks(self) -> None:
        if not self._dispatch_tasks:
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(*self._dispatch_tasks, return_exceptions=True),
                timeout=5,
            )
        except asyncio.TimeoutError:
            await self._cancel_dispatch_tasks()

    def _begin_shutdown(self, request: dict[str, Any] | None = None) -> bool:
        if self._stopping:
            return False
        self._stopping = True
        self._shutdown_request = request
        for session_id in self._worker.execution.active_session_ids():
            self._worker.execution.interrupt(session_id, "Worker shutting down")
        self._requests.put_nowait(None)
        return True

    async def _respond_to_shutdown(self) -> None:
        if self._shutdown_request is None or self._shutdown_response_sent:
            return
        self._shutdown_response_sent = True
        await self._respond(self._shutdown_request, {"ok": True})

    async def _dispatch(self, request: dict[str, Any]) -> None:
        method = str(request.get("method") or "")
        if method == RuntimeMethod.RIND_AUTH_PROMPT and str(request.get("request_id")) in self._auth_waiters:
            future = self._auth_waiters[str(request["request_id"])]
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            if not future.done():
                future.set_result(str(params.get("value") or ""))
            return
        try:
            if method == RuntimeMethod.INITIALIZE:
                await self._initialize(request)
                return
            if method == RuntimeMethod.PING:
                await self._respond(request, {"ok": True})
                return
            if not self._initialized:
                await self._respond_error(request, "Runtime worker is not initialized.", "ServerNotReady")
                return
            if method == RuntimeMethod.SESSION_LIST:
                await self._list_sessions(request)
                return
            if method == RuntimeMethod.SESSION_NEW:
                await self._new_session(request)
                return
            if method == RuntimeMethod.SESSION_SWITCH:
                await self._switch_session(request)
                return
            if method == RuntimeMethod.SESSION_DELETE:
                await self._delete_session(request)
                return
            if method == RuntimeMethod.SESSION_FORK:
                await self._fork_session(request)
                return
            if method == RuntimeMethod.RIND_CONTEXT_INSPECT:
                await self._context_inspect(request)
                return
            if method == RuntimeMethod.RIND_USAGE_SUMMARY:
                await self._usage_summary(request)
                return
            if method in {RuntimeMethod.SESSION_SUBSCRIBE, RuntimeMethod.SESSION_UNSUBSCRIBE}:
                await self._subscription_request(request)
                return
            if method == RuntimeMethod.MODEL_LIST:
                await self._list_models(request)
                return
            if method == RuntimeMethod.RIND_AUTH_LIST:
                await self._auth_list(request)
                return
            if method == RuntimeMethod.RIND_AUTH_LOGIN:
                await self._auth_login(request)
                return
            if method == RuntimeMethod.RIND_AUTH_LOGOUT:
                await self._auth_logout(request)
                return
            if method == RuntimeMethod.SESSION_REPLAY:
                await self._replay(request)
                return
            if method == RuntimeMethod.RIND_COMMAND_EXECUTE:
                await self._execute_command(request)
                return
            if method == RuntimeMethod.MODEL_SET:
                await self._set_model(request)
                return
            if method == RuntimeMethod.MODEL_EFFORT:
                await self._set_reasoning_effort(request)
                return
            if method in {
                RuntimeMethod.RIND_GOAL_GET,
                RuntimeMethod.RIND_GOAL_SET,
                RuntimeMethod.RIND_GOAL_STATUS,
                RuntimeMethod.RIND_GOAL_CLEAR,
            }:
                await self._goal_request(request)
                return
            if method in {RuntimeMethod.RIND_BACKGROUND_LIST, RuntimeMethod.RIND_BACKGROUND_OUTPUT}:
                await self._background_request(request)
                return
            if method in {RuntimeMethod.FILE_LIST, RuntimeMethod.FILE_READ, RuntimeMethod.FILE_WRITE}:
                await self._file_request(request)
                return
            if method in SESSION_SCOPED_METHODS:
                session_id = await self._required_session_id(request)
                if session_id is None:
                    return
                if method in TURN_SCOPED_METHODS and not await self._valid_turn(session_id, request):
                    return
                if method == RuntimeMethod.SESSION_PROMPT:
                    await self._run_turn(session_id, request)
                    return
                if method == RuntimeMethod.RIND_SESSION_COMPACT:
                    await self._compact(session_id, request)
                    return
                await self._handle_active_control(session_id, request)
                return
            await self._respond_error(request, f"Unknown method: {method}", "MethodNotFound")
        except LookupError as exc:
            await self._respond_error(request, str(exc), "SessionNotFound")
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

    async def _auth_list(self, request: dict[str, Any]) -> None:
        await self._respond(request, {"providers": self._worker.list_providers()})

    async def _auth_login(self, request: dict[str, Any]) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        provider_id = str(params.get("provider_id") or "").strip()
        method = str(params.get("method") or "api_key").strip()
        if not provider_id:
            await self._respond_error(request, "provider_id is required.", "InvalidRequest")
            return
        await self._worker.login(provider_id, method, _ProtocolAuthInteraction(self))
        info = await self._worker.session(session_id)
        listing = await self._worker.list_models(info.get("workspace_root"))
        selection = await self._adopt_login_default(session_id, info, provider_id, listing["models"])
        await self._respond(
            request,
            {"ok": True, "provider_id": provider_id, "models_count": len(listing["models"]), "selection": selection},
        )

    async def _adopt_login_default(self, session_id: str, info: dict[str, Any], provider_id: str, models: list[dict[str, Any]]) -> dict[str, str] | None:
        """Switch the session to the provider default when its current model is unusable."""
        current_provider = str(info.get("provider") or "")
        current_model = str(info.get("model") or "")
        if any(m.get("provider_id") == current_provider and m.get("id") == current_model for m in models):
            return None
        provider_models = [m for m in models if m.get("provider_id") == provider_id]
        if not provider_models:
            return None
        chosen = next((m for m in provider_models if m.get("id") == current_model), provider_models[0])
        store = await self._worker.repository.open_store(session_id, persist_system_prompt=False)
        await store.update_selection(provider_id, str(chosen["id"]))
        return {"provider_id": provider_id, "model_id": str(chosen["id"])}

    async def _auth_logout(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        provider_id = str(params.get("provider_id") or "").strip()
        if not provider_id:
            await self._respond_error(request, "provider_id is required.", "InvalidRequest")
            return
        deleted = self._worker.logout(provider_id)
        status = next((item for item in self._worker.list_providers() if item["id"] == provider_id), None)
        await self._respond(
            request,
            {
                "ok": True,
                "provider_id": provider_id,
                "deleted": deleted,
                "source": status["source"] if status else "none",
            },
        )

    async def _initialize(self, request: dict[str, Any]) -> None:
        info = await self._worker.initialize()
        session_id = str(info.get("session_id") or "")
        if session_id:
            self._subscribed.add(session_id)
        result = {
            "session_id": info["session_id"],
            "draft": bool(info.get("draft")),
            "model": info.get("model"),
            "provider": info.get("provider"),
            "reasoning_effort": info.get("reasoning_effort"),
            "base_url": info.get("base_url"),
            "workspace_root": info.get("workspace_root"),
            "team_main": info.get("team_main"),
            "version": __version__,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": self._capabilities(),
            "methods": self._methods(),
            "resume_preview": "" if info.get("message_count", 0) <= 1 else await self._resume_preview(info["session_id"]),
            "turn_state": info.get("turn_state"),
            "live_turn": info.get("live_turn"),
            "commands": self._slash_command_infos(),
            "providers": self._worker.list_providers(),
        }
        if self._goal_enabled:
            result["goal"] = info.get("goal")
        await self._respond(request, result)
        self._initialized = True

    def _capabilities(self) -> list[str]:
        return protocol_capabilities(background_enabled(self._background_list, self._background_output), self._goal_enabled)

    def _methods(self) -> list[str]:
        return protocol_methods(background_enabled(self._background_list, self._background_output), self._goal_enabled)

    def _slash_command_infos(self) -> list[dict[str, Any]]:
        return slash_command_infos(self._slash_router)

    async def _run_turn(self, session_id: str, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_query = params.get("input")
        if raw_query is None:
            raw_query = params.get("query")
        query = str(raw_query or "")
        resume = params.get("resume") is True
        if not query.strip() and not resume:
            await self._respond_error(request, "session/prompt requires input.", "InvalidRequest")
            return
        if resume and query.strip():
            await self._respond_error(request, "resume cannot include input.", "InvalidRequest")
            return
        transient_system_messages = params.get("transient_system_messages")
        if not isinstance(transient_system_messages, list):
            transient_system_messages = None
        # Subscribe before the turn runs so its events are never dropped.
        self._subscribed.add(session_id)
        turn_session_id = ""
        turn_id = ""
        async for event in self._worker.execution.run_turn(
            session_id,
            query=query,
            transient_system_messages=transient_system_messages,
            resume=resume,
        ):
            turn_session_id = turn_session_id or str(event.get("session_id") or "")
            turn_id = turn_id or str(event.get("turn_id") or "")
            await self._send_event(event)
        await self._respond(
            request,
            {
                "ok": True,
                "session_id": turn_session_id or session_id,
                "turn_id": turn_id,
            },
        )

    async def _compact(self, session_id: str, request: dict[str, Any]) -> None:
        container = self._worker.execution.active_container(session_id)
        if container is not None and container.runtime.turn_active:
            await self._respond_error(request, "Cannot compact context while a turn is active.", "TurnActive")
            return
        self._subscribed.add(session_id)
        await self._respond(request, await self._worker.execution.compact_context(session_id))

    async def _handle_active_control(self, session_id: str, request: dict[str, Any]) -> None:
        method = request.get("method")
        if method == RuntimeMethod.SESSION_CANCEL:
            if not self._worker.execution.interrupt(session_id):
                await self._respond_error(request, "No active turn to interrupt.", "TurnNotActive")
                return
            await self._respond(request, {"ok": True})
            return
        if method == RuntimeMethod.RIND_USER_QUESTION_RESPOND:
            params = request.get("params") if isinstance(request.get("params"), dict) else {}
            try:
                await self._worker.execution.answer_user_question(
                    session_id,
                    str(params.get("tool_call_id") or ""),
                    str(params.get("answer") or "").strip(),
                )
            except LookupError as exc:
                await self._respond_error(request, str(exc), "QuestionNotFound")
                return
            await self._respond(request, {"ok": True})
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        try:
            if method == RuntimeMethod.RIND_SESSION_STEER:
                result = self._worker.execution.submit_input(session_id, "steering", str(params.get("input") or ""))
            elif method == RuntimeMethod.RIND_SESSION_FOLLOW_UP:
                result = self._worker.execution.submit_input(session_id, "follow_up", str(params.get("input") or ""))
            elif method == RuntimeMethod.RIND_SESSION_PROMOTE_FOLLOW_UP:
                result = self._worker.execution.promote_follow_up(session_id, str(params.get("input_id") or ""))
            elif method == RuntimeMethod.RIND_SESSION_UNSTEER:
                result = self._worker.execution.retrieve_input(session_id, "steering", params.get("input_id"))
            elif method == RuntimeMethod.RIND_SESSION_DEQUEUE_FOLLOW_UP:
                result = self._worker.execution.retrieve_input(session_id, "follow_up", params.get("input_id"))
            else:
                await self._respond_error(request, "Session execution is not active.", "TurnNotActive")
                return
        except InputQueueError as exc:
            await self._respond_error(request, str(exc), exc.error_type)
            return
        except RuntimeError as exc:
            await self._respond_error(request, str(exc), "TurnNotActive")
            return
        await self._respond(request, result)

    async def _resume_preview(self, session_id: str) -> str:
        replay = await self._worker.repository.replay(session_id, end=20)
        messages = replay.get("messages") if isinstance(replay, dict) else []
        return render_resume_preview(messages if isinstance(messages, list) else [], session_id=session_id)

    async def _list_sessions(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        limit = params.get("limit", 20)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            await self._respond_error(request, "session/list limit must be an integer from 1 to 100.", "InvalidRequest")
            return
        workspace_root = params.get("workspace_root")
        if workspace_root is not None:
            if not isinstance(workspace_root, str) or not workspace_root.strip():
                await self._respond_error(request, "workspace_root must be a non-empty string.", "InvalidRequest")
                return
        sessions = await self._worker.repository.list(limit=limit, workspace_root=workspace_root)
        await self._respond(
            request,
            {
                "sessions": sessions,
                "current_session_id": self._worker.session_id,
            },
        )

    async def _new_session(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        workspace_root = params.get("workspace_root", self._worker.workspace_root)
        if not isinstance(workspace_root, str) or not workspace_root.strip():
            await self._respond_error(request, "workspace_root must be a non-empty string.", "InvalidRequest")
            return
        info = await self._worker.create_session(workspace_root)
        created_session_id = str(info.get("session_id") or "")
        if created_session_id:
            self._subscribed.add(created_session_id)
        await self._respond(request, info)

    async def _switch_session(self, request: dict[str, Any]) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        info = await self._worker.session(session_id)
        self._subscribed.add(session_id)
        await self._respond(request, info)

    async def _delete_session(self, request: dict[str, Any]) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        if session_id == self._worker.session_id:
            await self._respond_error(request, "Cannot delete the current session. Switch to another session first.", "InvalidRequest")
            return
        if session_id in self._worker.execution.active_session_ids():
            await self._respond_error(request, "Cannot delete a session with an active turn.", "TurnActive")
            return
        await self._worker.delete_session(session_id)
        self._subscribed.discard(session_id)
        await self._respond(request, {"ok": True, "deleted": session_id})

    async def _fork_session(self, request: dict[str, Any]) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        if session_id in self._worker.execution.active_session_ids():
            await self._respond_error(request, "Cannot fork a session with an active turn.", "TurnActive")
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        before_message_id = params.get("before_message_id")
        if before_message_id is not None and not isinstance(before_message_id, str):
            await self._respond_error(request, "before_message_id must be a string.", "InvalidRequest")
            return
        try:
            result = await self._worker.fork_session(session_id, before_message_id)
        except ValueError as exc:
            await self._respond_error(request, str(exc), "InvalidRequest")
            return
        await self._respond(request, result)

    async def _context_inspect(self, request: dict[str, Any]) -> None:
        """Read the session's latest context breakdown and assistant sampling usage from meta."""
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        meta = await self._worker.repository.metadata(session_id)
        breakdown = meta.get("latest_context_breakdown")
        # Assistant samplings describe the context the board shows; a compact
        # sampling would read the pre-compaction context, so it never anchors.
        usage = meta.get("latest_assistant_sampling_usage")
        await self._respond(
            request,
            {
                "session_id": session_id,
                "breakdown": copy.deepcopy(breakdown) if isinstance(breakdown, dict) else None,
                "latest_usage": copy.deepcopy(usage) if isinstance(usage, dict) else None,
            },
        )

    async def _usage_summary(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        days = params.get("days", 7)
        if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 365:
            await self._respond_error(request, "rind/usage/summary days must be an integer from 1 to 365.", "InvalidRequest")
            return
        await self._respond(request, await self._worker.usage_summary(days))

    async def _subscription_request(self, request: dict[str, Any]) -> None:
        method = str(request.get("method") or "")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_session_id = params.get("session_id")
        if not isinstance(raw_session_id, str) or not raw_session_id.strip():
            await self._respond_error(request, f"{method} requires session_id.", "InvalidRequest")
            return
        try:
            session_id = validate_session_id(raw_session_id)
        except ValueError as exc:
            await self._respond_error(request, str(exc), "InvalidRequest")
            return
        # Mirror session/switch: unknown sessions surface as SessionNotFound.
        await self._worker.session(session_id)
        if method == RuntimeMethod.SESSION_SUBSCRIBE:
            self._subscribed.add(session_id)
        else:
            self._subscribed.discard(session_id)
        await self._respond(request, {"ok": True, "subscribed": sorted(self._subscribed)})

    async def _list_models(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        session_id = params.get("session_id")
        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                await self._respond_error(request, "session_id must be a non-empty string.", "InvalidRequest")
                return
        else:
            session_id = (await self._worker.initialize())["session_id"]
        info = await self._worker.session(session_id)
        refresh = bool(params.get("refresh", False))
        listing = await self._worker.list_models(info.get("workspace_root"), refresh=refresh)
        current_model = str(info.get("model") or "")
        current_provider = str(info.get("provider") or "")
        await self._respond(
            request,
            {
                **listing,
                "current": {"provider_id": current_provider, "model_id": current_model},
                "current_model": current_model,
                "default_model": current_model,
            },
        )

    async def _replay(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        after_cursor = params.get("after_cursor")
        if "after_cursor" in params:
            if isinstance(after_cursor, bool) or not isinstance(after_cursor, int) or after_cursor < 0:
                await self._respond_error(
                    request,
                    "session/replay after_cursor must be a non-negative integer.",
                    "InvalidRequest",
                )
                return
            await self._replay_event_pages(request, after_cursor)
            return
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        start = params.get("start") if isinstance(params.get("start"), int) else None
        end = params.get("end") if isinstance(params.get("end"), int) else None
        result = await self._worker.replay(session_id, start=start, end=end)
        await self._respond(request, result)

    async def _replay_event_pages(self, request: dict[str, Any], after_cursor: int) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        materials = await self._worker.replay_event_pages(session_id)
        messages = materials.get("messages") if isinstance(materials.get("messages"), list) else []
        tool_records = materials.get("tool_records") if isinstance(materials.get("tool_records"), list) else []
        events = iter_durable_events(messages, tool_records, materials.get("turn_state"), session_id)
        envelopes = []
        cursor = 0
        for cursor, event in enumerate(events, start=1):
            if cursor > after_cursor:
                envelopes.append(event_envelope(event, cursor))
        await self._respond(request, {"events": envelopes, "cursor": cursor})

    async def _file_request(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        method = str(request.get("method") or "")
        try:
            if method == RuntimeMethod.FILE_LIST:
                result = file_list(self._worker.workspace_root, str(params.get("path") or ""))
            elif method == RuntimeMethod.FILE_READ:
                result = file_read(self._worker.workspace_root, str(params.get("path") or ""))
            else:
                result = file_write(
                    self._worker.workspace_root,
                    str(params.get("path") or ""),
                    params.get("content_base64"),
                )
        except FileMethodError as exc:
            await self._respond_error(request, exc.message, exc.error_type)
            return
        await self._respond(request, result)

    async def _execute_command(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        session_id = params.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            session_id = self._worker.session_id
        if not isinstance(session_id, str) or not session_id.strip():
            await self._respond_error(request, "session_id is required for this command.", "InvalidRequest")
            return
        raw_input = str(params.get("input") or "").strip()
        command = raw_input.split(maxsplit=1)[0].lstrip("/").lower() if raw_input else ""
        needs_execution = command == "team"
        if command == "compact":
            self._subscribed.add(session_id)
        active = self._worker.execution.active_container(session_id)
        owns_execution = active is None and needs_execution
        if needs_execution:
            active = await self._worker.start_execution(session_id)
        store = active.session_store if active is not None else await self._worker.repository.open_store(
            session_id,
            persist_system_prompt=False,
        )
        try:
            result = await self._slash_router.execute(
                raw_input,
                SlashCommandContext(
                    runtime=active.runtime if active is not None else None,
                    session=store,
                    debug=self._debug,
                    workspace_root=getattr(store, "workspace_root", None),
                    compact_context=lambda: self._worker.execution.compact_context(session_id),
                ),
            )
            await self._respond_slash_result(request, result)
        finally:
            if owns_execution:
                await self._worker.release_execution(session_id)

    async def _set_model(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        provider_id = str(params.get("provider_id") or "").strip()
        model = str(params.get("model_id") or params.get("model") or "").strip()
        if not model:
            await self._respond_error(request, "model/set requires model.", "InvalidRequest")
            return
        active = self._worker.execution.active_container(session_id)
        store = active.session_store if active is not None else await self._worker.repository.open_store(session_id, persist_system_prompt=False)
        provider_id = provider_id or str(getattr(store, "provider", "openai-compatible") or "openai-compatible")
        await store.update_selection(provider_id, model)
        await self._respond(request, {"provider_id": provider_id, "model_id": model, "model": model, "session": True, "runtime": False})

    async def _set_reasoning_effort(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        effort = str(params.get("reasoning_effort") or "").strip().lower()
        if not effort:
            await self._respond_error(request, "model/effort requires reasoning_effort.", "InvalidRequest")
            return
        active = self._worker.execution.active_container(session_id)
        store = active.session_store if active is not None else await self._worker.repository.open_store(
            session_id, persist_system_prompt=False
        )
        await store.update_reasoning_effort(effort)
        await self._respond(request, {"reasoning_effort": effort, "session": True})

    async def _goal_request(self, request: dict[str, Any]) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        active = self._worker.execution.active_container(session_id)
        if active is not None:
            store = active.runtime
            start_continuation = lambda: self._start_goal_continuation(session_id)
            interrupt = lambda: self._worker.execution.interrupt(session_id)
        else:
            repository = self._worker.repository
            store = _RepositoryGoalOps(repository, session_id)
            start_continuation = lambda: self._start_goal_continuation(session_id)
            interrupt = lambda: None

        method = request.get("method")
        if method == RuntimeMethod.RIND_GOAL_GET:
            await self._respond(request, {"goal": await store.get_goal()})
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        if method == RuntimeMethod.RIND_GOAL_SET:
            objective = params.get("objective")
            if not isinstance(objective, str) or not objective.strip():
                await self._respond_error(request, "rind/goal/set requires objective.", "InvalidRequest")
                return
            goal = await store.set_goal(objective)
            await self._respond(request, {"goal": goal})
            await start_continuation()
            return
        if method == RuntimeMethod.RIND_GOAL_STATUS:
            status = params.get("status")
            if status not in {"active", "paused"}:
                await self._respond_error(request, "rind/goal/status requires active or paused.", "InvalidRequest")
                return
            goal = await store.set_goal_status(status)
            await self._respond(request, {"goal": goal})
            if status == "active":
                await start_continuation()
            if status == "paused":
                interrupt()
            return
        await store.clear_goal()
        interrupt()
        await self._respond(request, {"goal": None})

    async def _start_goal_continuation(self, session_id: str) -> None:
        start = getattr(self._worker.execution, "start_goal_continuation", None)
        if callable(start):
            await start(session_id)

    async def _background_request(self, request: dict[str, Any]) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        method = request.get("method")
        if method == RuntimeMethod.RIND_BACKGROUND_LIST:
            await self._list_backgrounds_for_session(request, session_id)
            return
        await self._background_output_for_session(request, session_id)

    async def _list_backgrounds_for_session(self, request: dict[str, Any], session_id: str) -> None:
        if self._background_list is None:
            await self._respond_error(request, "Background monitoring is unavailable.", "UnsupportedOperation")
            return
        try:
            await self._respond(request, await background_list_response(self._background_list, session_id))
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

    async def _background_output_for_session(self, request: dict[str, Any], session_id: str) -> None:
        if self._background_output is None:
            await self._respond_error(request, "Background monitoring is unavailable.", "UnsupportedOperation")
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        try:
            response = await background_output_response(self._background_output, session_id, params)
        except ValueError as exc:
            await self._respond_error(request, str(exc), "InvalidRequest")
            return
        except LookupError as exc:
            await self._respond_error(request, str(exc), "NotFound")
            return
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)
            return
        await self._respond(request, response)

    async def _required_session_id(self, request: dict[str, Any]) -> str | None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        value = params.get("session_id")
        if not isinstance(value, str) or not value.strip():
            await self._respond_error(request, "session_id is required for this method.", "InvalidRequest")
            return None
        try:
            return validate_session_id(value)
        except ValueError as exc:
            await self._respond_error(request, str(exc), "InvalidRequest")
            return None

    async def _valid_turn(self, session_id: str, request: dict[str, Any]) -> bool:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        expected = params.get("turn_id")
        active = self._worker.execution.active_turn_id(session_id)
        if request.get("method") == RuntimeMethod.SESSION_CANCEL and expected in {None, ""} and active:
            return True
        if not isinstance(expected, str) or not expected.strip() or not active or expected != active:
            await self._respond_error(request, "The requested turn is no longer active.", "TurnNotActive")
            return False
        return True

    async def _send_event(self, event: dict[str, Any]) -> None:
        event_session_id = str(event.get("session_id") or "")
        if event_session_id and event_session_id not in self._subscribed:
            return
        await self._writer.send(event_envelope(event, 0))


    async def _respond(self, request: dict[str, Any], result: Any) -> None:
        await self._writer.send(response_message(request, result))

    async def _respond_slash_result(self, request: dict[str, Any], result: SlashCommandResult) -> None:
        await self._respond(request, result.to_dict())

    async def _respond_error(self, request: dict[str, Any], message: str, error_type: str) -> None:
        await self._writer.send(error_message(request, message, error_type))
