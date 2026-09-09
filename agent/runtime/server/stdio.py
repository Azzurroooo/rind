"""JSONL stdio adapter for the headless Rind runtime."""

from __future__ import annotations

import asyncio
import inspect
import json
import signal
import sys
import threading
from collections.abc import Callable
from typing import Any

from agent.runtime.core import InputQueueError
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import UserQuestionRequestedEvent
from agent.infrastructure.config import validate_settings
from agent.infrastructure.llm import OpenAIClientFactory, close_async_client
from agent.infrastructure.paths import validate_session_id
from agent.version import __version__
from agent.runtime.server.commands import SlashCommandContext, SlashCommandResult, SlashCommandRouter
from agent.runtime.server.commands.model_control import set_active_model, set_active_reasoning_effort
from agent.runtime.server.resume_preview import render_resume_preview
from agent.runtime.server.files import FileMethodError, file_list, file_read, file_write
from agent.runtime.server.replay_events import project_durable_events
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
    validate_request,
)


class JsonlWriter:
    def __init__(self):
        self._lock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        async with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()



def configure_utf8_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def configure_stdio_server_signals() -> None:
    signal.signal(signal.SIGINT, signal.SIG_IGN)


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


def merge_models(models: list[str], current_model: str) -> list[str]:
    values = sorted({model for model in models if model})
    if current_model and current_model not in values:
        values.insert(0, current_model)
    return values


async def fetch_model_ids(client: Any) -> list[str]:
    def _model_id(item: Any) -> str:
        return str(item.get("id") if isinstance(item, dict) else getattr(item, "id", "") or "").strip()

    response = client.models.list()
    if hasattr(response, "__aiter__"):
        return [_model_id(item) async for item in response]
    if inspect.isawaitable(response):
        response = await response
    data = getattr(response, "data", response)
    if hasattr(data, "__aiter__"):
        return [_model_id(item) async for item in data]
    if not isinstance(data, list | tuple):
        try:
            data = list(data)
        except TypeError:
            data = []
    return [_model_id(item) for item in data]


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


class StdioRuntimeServer:
    def __init__(
        self,
        runtime,
        session,
        debug: bool = False,
        *,
        model_client_factory: Callable[[], Any] | None = None,
        model_client: Any | None = None,
        default_model: str = "",
        background_list: Callable[[str], Any] | None = None,
        background_output: Callable[..., Any] | None = None,
        goal_enabled: bool = False,
        writer: JsonlWriter | None = None,
        slash_router: SlashCommandRouter | None = None,
        event_observer: Callable[[dict[str, Any]], Any] | None = None,
        input_observer: Callable[[dict[str, Any]], Any] | None = None,
    ):
        self._runtime = runtime
        self._session = session
        self._debug = debug
        self._model_client_factory = model_client_factory
        self._model_client = model_client
        self._default_model = str(default_model or "").strip()
        self._background_list = background_list
        self._background_output = background_output
        self._goal_enabled = bool(goal_enabled)
        self._slash_router = slash_router or SlashCommandRouter()
        self._writer = writer or JsonlWriter()
        self._event_observer = event_observer
        self._input_observer = input_observer
        self._requests: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._pending_answers: dict[str, asyncio.Future[str]] = {}
        self._current_cancel: CancellationTokenSource | None = None
        self._queued_turn_starts = 0
        self._initialized = False
        self._turn_slot = asyncio.Lock()
        self._dispatch_tasks: set[asyncio.Task] = set()
        self._sequence = 0
        self._stopping = False
        self._shutdown_request: dict[str, Any] | None = None
        self._shutdown_response_sent = False
        self._install_question_responder()

    async def run(self) -> int:
        self._start_stdin_pump()
        return await self._serve()

    def _start_stdin_pump(self) -> None:
        # A daemon thread keeps a blocked stdin read from holding the interpreter
        # open after shutdown; asyncio.to_thread workers are joined at exit.
        loop = asyncio.get_running_loop()

        def _pump() -> None:
            while not self._stopping:
                line = sys.stdin.readline()
                if line == "":
                    break
                asyncio.run_coroutine_threadsafe(self._ingest_line(line), loop)
            asyncio.run_coroutine_threadsafe(self._ingest_eof(), loop)

        threading.Thread(target=_pump, name="rind-stdin-pump", daemon=True).start()

    async def _ingest_eof(self) -> None:
        self._begin_shutdown()

    def _install_question_responder(self) -> None:
        set_responder = getattr(self._runtime, "set_user_question_responder", None)
        if callable(set_responder):
            set_responder(self._answer_user_question)

    async def _serve(self) -> int:
        while True:
            request = await self._requests.get()
            if request is None:
                await self._cancel_dispatch_tasks()
                await self._respond_to_shutdown()
                return 0
            method = str(request.get("method") or "")
            if method == RuntimeMethod.SHUTDOWN:
                self._begin_shutdown(request)
                continue
            if self._stopping:
                await self._respond_error(
                    request,
                    "Runtime is shutting down.",
                    "ServerStopping",
                )
                continue
            if method == RuntimeMethod.INITIALIZE:
                # Initialization gates every other method, so keep it serial.
                await self._dispatch(request)
                continue
            # Concurrent dispatch keeps commands and queries responsive while a
            # turn occupies the runtime; per-resource locks preserve ordering.
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

    def _begin_shutdown(self, request: dict[str, Any] | None = None) -> bool:
        if self._stopping:
            return False
        self._stopping = True
        self._shutdown_request = request
        self._interrupt_current()
        self._requests.put_nowait(None)
        return True

    async def _respond_to_shutdown(self) -> None:
        if self._shutdown_request is None or self._shutdown_response_sent:
            return
        self._shutdown_response_sent = True
        await self._respond(self._shutdown_request, {"ok": True})

    async def _dispatch(self, request: dict[str, Any]) -> None:
        method = str(request.get("method") or "")
        try:
            if method == RuntimeMethod.INITIALIZE:
                await self._initialize(request)
            elif method == RuntimeMethod.SESSION_PROMPT:
                await self._run_turn(request)
            elif method == RuntimeMethod.SESSION_REPLAY:
                await self._replay(request)
            elif method == RuntimeMethod.RIND_SESSION_COMPACT:
                await self._compact(request)
            elif method == RuntimeMethod.MODEL_LIST:
                await self._list_models(request)
            elif method == RuntimeMethod.MODEL_SET:
                await self._set_model(request)
            elif method == RuntimeMethod.MODEL_EFFORT:
                await self._set_reasoning_effort(request)
            elif method == RuntimeMethod.SESSION_SWITCH:
                await self._switch_session(request)
            elif method == RuntimeMethod.SESSION_LIST:
                await self._list_sessions(request)
            elif method == RuntimeMethod.SESSION_NEW:
                await self._new_session(request)
            elif method == RuntimeMethod.RIND_BACKGROUND_LIST:
                await self._list_backgrounds(request)
            elif method == RuntimeMethod.RIND_BACKGROUND_OUTPUT:
                await self._background_output_request(request)
            elif method == RuntimeMethod.RIND_GOAL_GET:
                await self._goal_get(request)
            elif method == RuntimeMethod.RIND_GOAL_SET:
                await self._goal_set(request)
            elif method == RuntimeMethod.RIND_GOAL_STATUS:
                await self._goal_status(request)
            elif method == RuntimeMethod.RIND_GOAL_CLEAR:
                await self._goal_clear(request)
            elif method == RuntimeMethod.RIND_COMMAND_EXECUTE:
                await self._execute_slash(request)
            else:
                await self._respond_error(request, f"Unknown method: {method}", "MethodNotFound")
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

    async def _initialize(self, request: dict[str, Any]) -> None:
        await self._runtime.initialize()
        result = {
            "session_id": getattr(self._session, "session_id", None),
            "draft": getattr(self._session, "session_id", None) is None,
            "model": getattr(self._session, "model", None),
            "reasoning_effort": getattr(self._session, "reasoning_effort", None),
            "version": __version__,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": self._capabilities(),
            "methods": self._methods(),
            "resume_preview": await self._resume_preview(),
            "turn_state": await self._turn_state(),
            "commands": self._slash_command_infos(),
        }
        if self._goal_enabled:
            result["goal"] = await self._runtime.get_goal()
        self._initialized = True
        await self._respond(
            request,
            result,
        )

    def _capabilities(self) -> list[str]:
        return protocol_capabilities(background_enabled(self._background_list, self._background_output), self._goal_enabled)

    def _methods(self) -> list[str]:
        return protocol_methods(background_enabled(self._background_list, self._background_output), self._goal_enabled)

    def _slash_command_infos(self) -> list[dict[str, Any]]:
        return slash_command_infos(self._slash_router)

    async def _resume_preview(self) -> str:
        get_messages = getattr(self._session, "get_messages_slice", None)
        if not callable(get_messages):
            return ""
        messages = await get_messages(compacted=False)
        return render_resume_preview(messages, session_id=getattr(self._session, "session_id", None))

    async def _turn_state(self) -> dict[str, Any] | None:
        get_state = getattr(self._session, "get_turn_state", None)
        if not callable(get_state):
            return None
        state = await get_state()
        return dict(state) if isinstance(state, dict) else None

    async def _replay(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        start = params.get("start") if isinstance(params.get("start"), int) else None
        end = params.get("end") if isinstance(params.get("end"), int) else None
        requested_session_id = params.get("session_id")
        if requested_session_id is not None:
            if not isinstance(requested_session_id, str) or not requested_session_id.strip():
                await self._respond_error(request, "session/replay requires a non-empty session_id.", "InvalidRequest")
                return
            try:
                session_id = validate_session_id(requested_session_id)
            except ValueError as exc:
                await self._respond_error(request, str(exc), "InvalidRequest")
                return
            if session_id != getattr(self._session, "session_id", None):
                get_messages_for_session = getattr(self._session, "get_messages_for_session", None)
                if not callable(get_messages_for_session):
                    await self._respond_error(request, "Read-only session replay is unavailable.", "UnsupportedOperation")
                    return
                messages = await get_messages_for_session(session_id, start=start, end=end, compacted=False)
                await self._respond(
                    request,
                    {
                        "messages": messages,
                        "turn_state": None,
                        "session_id": session_id,
                        "model": getattr(self._session, "model", None),
                    },
                )
                return
        get_messages = getattr(self._session, "get_messages_slice", None)
        if not callable(get_messages):
            await self._respond(
                request,
                {
                    "messages": [],
                    "turn_state": await self._turn_state(),
                    "model": getattr(self._session, "model", None),
                },
            )
            return
        if start is None and end is None:
            messages = await get_messages(compacted=False)
        else:
            messages = await get_messages(
                start=start,
                end=end,
                compacted=False,
            )
        await self._respond(
            request,
            {
                "messages": messages,
                "turn_state": await self._turn_state(),
                "model": getattr(self._session, "model", None),
            },
        )

    async def _run_turn(self, request: dict[str, Any]) -> None:
        try:
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

            async with self._turn_slot:
                cancel_source = CancellationTokenSource()
                self._current_cancel = cancel_source
                turn_session_id = ""
                turn_id = ""
                try:
                    run_kwargs = {
                        "query": query,
                        "cancellation_token": cancel_source.token,
                        "transient_system_messages": transient_system_messages,
                    }
                    if resume:
                        run_kwargs["resume"] = True
                    async for event in self._runtime.run_turn(**run_kwargs):
                        event_data = event.to_dict()
                        turn_session_id = turn_session_id or str(event_data.get("session_id") or "")
                        turn_id = turn_id or str(event_data.get("turn_id") or "")
                        await self._send_event(event_data)
                    await self._respond(
                        request,
                        {
                            "ok": True,
                            "session_id": turn_session_id or str(getattr(self._session, "session_id", "") or ""),
                            "turn_id": turn_id,
                        },
                    )
                finally:
                    if self._current_cancel is cancel_source:
                        self._current_cancel = None
                    cancel_source.dispose()
        finally:
            self._queued_turn_starts = max(0, self._queued_turn_starts - 1)

    async def _compact(self, request: dict[str, Any]) -> None:
        if getattr(self._runtime, "turn_active", False):
            await self._respond_error(
                request,
                "Cannot compact context while a turn is active.",
                "TurnActive",
            )
            return
        record = await self._runtime.compact_context(reason="manual")
        await self._respond(request, record)

    async def _list_models(self, request: dict[str, Any]) -> None:
        client = self._model_client
        owns_client = client is None
        if client is None and self._model_client_factory is None:
            raise RuntimeError("Model listing is unavailable.")
        if client is None:
            client = self._model_client_factory()
        try:
            models = await fetch_model_ids(client)
            current_model = self._current_model()
            default_model = self._default_model
            merged = merge_models(models, current_model)
        finally:
            if owns_client:
                await close_async_client(client)
        await self._respond(
            request,
            {
                "models": merged,
                "current_model": current_model,
                "default_model": default_model,
            },
        )

    async def _set_model(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        model = str(params.get("model") or "").strip()
        if not model:
            await self._respond_error(request, "model/set requires model.", "InvalidRequest")
            return
        result = await set_active_model(self._runtime, self._session, model)
        await self._respond(request, result)

    async def _set_reasoning_effort(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        effort = str(params.get("reasoning_effort") or "").strip().lower()
        if not effort:
            await self._respond_error(request, "model/effort requires reasoning_effort.", "InvalidRequest")
            return
        result = await set_active_reasoning_effort(self._runtime, self._session, effort)
        await self._respond(request, result)

    async def _switch_session(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_session_id = params.get("session_id")
        if not isinstance(raw_session_id, str) or not raw_session_id.strip():
            await self._respond_error(request, "session/switch requires session_id.", "InvalidRequest")
            return
        try:
            session_id = validate_session_id(raw_session_id)
        except ValueError as exc:
            await self._respond_error(request, str(exc), "InvalidRequest")
            return
        switch = getattr(self._runtime, "switch_session", None)
        if not callable(switch):
            await self._respond_error(request, "Session switching is unavailable.", "UnsupportedOperation")
            return
        result = await switch(session_id)
        usage = result.get("assistant_usage") or result.get("usage")
        response = {
            "session_id": result.get("session_id") or getattr(self._session, "session_id", None),
            "draft": result.get("draft") is True,
            "model": result.get("model") or getattr(self._session, "model", None),
            "usage": usage if isinstance(usage, dict) else None,
            "resume_preview": await self._resume_preview(),
        }
        if self._goal_enabled:
            response["goal"] = result.get("goal")
        await self._respond(
            request,
            response,
        )

    async def _list_sessions(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        limit = params.get("limit", 20)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            await self._respond_error(request, "session/list limit must be an integer from 1 to 100.", "InvalidRequest")
            return
        list_sessions = getattr(self._session, "list_recent_sessions", None)
        if not callable(list_sessions):
            await self._respond_error(request, "Session listing is unavailable.", "UnsupportedOperation")
            return
        sessions = await list_sessions(limit=limit)
        await self._respond(
            request,
            {
                "sessions": sessions,
                "current_session_id": getattr(self._session, "session_id", None),
            },
        )

    async def _new_session(self, request: dict[str, Any]) -> None:
        create = getattr(self._runtime, "create_session", None)
        if not callable(create):
            await self._respond_error(request, "Session creation is unavailable.", "UnsupportedOperation")
            return
        result = await create()
        usage = result.get("assistant_usage") or result.get("usage")
        response = {
            "session_id": result.get("session_id") or getattr(self._session, "session_id", None),
            "draft": result.get("draft") is True,
            "model": result.get("model") or getattr(self._session, "model", None),
            "usage": usage if isinstance(usage, dict) else None,
            "resume_preview": await self._resume_preview(),
        }
        if self._goal_enabled:
            response["goal"] = result.get("goal")
        await self._respond(request, response)

    async def _goal_get(self, request: dict[str, Any]) -> None:
        if not self._goal_enabled:
            await self._respond_error(request, "Goal support is unavailable.", "UnsupportedOperation")
            return
        await self._respond(request, {"goal": await self._runtime.get_goal()})

    async def _goal_set(self, request: dict[str, Any]) -> None:
        if not self._goal_enabled:
            await self._respond_error(request, "Goal support is unavailable.", "UnsupportedOperation")
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        objective = params.get("objective")
        if not isinstance(objective, str) or not objective.strip():
            await self._respond_error(request, "rind/goal/set requires objective.", "InvalidRequest")
            return
        try:
            goal = await self._runtime.set_goal(objective)
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)
            return
        await self._respond(request, {"goal": goal})

    async def _goal_status(self, request: dict[str, Any]) -> None:
        if not self._goal_enabled:
            await self._respond_error(request, "Goal support is unavailable.", "UnsupportedOperation")
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        status = params.get("status")
        if status not in {"active", "paused"}:
            await self._respond_error(request, "rind/goal/status requires active or paused.", "InvalidRequest")
            return
        try:
            goal = await self._runtime.set_goal_status(status)
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)
            return
        if status == "paused":
            self._interrupt_current()
        await self._respond(request, {"goal": goal})

    async def _goal_clear(self, request: dict[str, Any]) -> None:
        if not self._goal_enabled:
            await self._respond_error(request, "Goal support is unavailable.", "UnsupportedOperation")
            return
        try:
            await self._runtime.clear_goal()
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)
            return
        self._interrupt_current()
        await self._respond(request, {"goal": None})

    def _current_model(self) -> str:
        session_model = str(getattr(self._session, "model", "") or "").strip()
        return session_model or self._default_model

    async def _execute_slash(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_input = str(params.get("input") or "")
        result = await self._slash_router.execute(
            raw_input,
            SlashCommandContext(
                runtime=self._runtime,
                session=self._session,
                debug=self._debug,
                workspace_root=getattr(self._session, "workspace_root", None),
            ),
        )
        await self._respond_slash_result(request, result)

    async def _ingest_line(self, line: str) -> None:
        message, parse_error = self._parse_line(line)
        if parse_error is not None:
            await self._respond_error({}, parse_error, "ParseError")
            return
        request_error = validate_request(message)
        if request_error is not None:
            await self._respond_error(message, request_error, "InvalidRequest")
            return
        if await self._handle_control_message(message):
            return
        if message.get("method") == RuntimeMethod.SESSION_PROMPT:
            self._queued_turn_starts += 1
        await self._requests.put(message)

    def _parse_line(self, line: str) -> tuple[dict[str, Any], str | None]:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            return {}, "Invalid JSON request."
        if not isinstance(value, dict):
            return {}, "JSONL request must be an object."
        return value, None

    async def _handle_control_message(self, message: dict[str, Any]) -> bool:
        method = str(message.get("method") or "")
        if method == RuntimeMethod.SHUTDOWN:
            if not self._begin_shutdown(message):
                await self._respond_error(message, "Runtime is shutting down.", "ServerStopping")
            return True
        if method == RuntimeMethod.RIND_SESSION_STEER:
            await self._submit_queued_input(message, self._runtime.submit_steering)
            return True
        if method == RuntimeMethod.RIND_SESSION_FOLLOW_UP:
            await self._submit_queued_input(message, self._runtime.submit_follow_up)
            return True
        if method == RuntimeMethod.RIND_SESSION_PROMOTE_FOLLOW_UP:
            await self._promote_queued_input(message)
            return True
        if method == RuntimeMethod.RIND_SESSION_UNSTEER:
            await self._retrieve_queued_input(message, self._runtime.unsteer)
            return True
        if method == RuntimeMethod.RIND_SESSION_DEQUEUE_FOLLOW_UP:
            await self._retrieve_queued_input(message, self._runtime.dequeue_follow_up)
            return True
        if method == RuntimeMethod.SESSION_CANCEL:
            if not self._interrupt_current():
                await self._respond_error(message, "No active turn to interrupt.", "TurnNotActive")
                return True
            await self._respond(message, {"ok": True})
            return True
        if method == RuntimeMethod.RIND_USER_QUESTION_RESPOND:
            await self._receive_user_answer(message)
            return True
        if method == RuntimeMethod.RIND_COMMAND_EXECUTE and self._initialized:
            self._schedule_dispatch(message)
            return True
        if method == RuntimeMethod.RIND_BACKGROUND_LIST:
            await self._list_backgrounds(message)
            return True
        if method == RuntimeMethod.RIND_BACKGROUND_OUTPUT:
            await self._background_output_request(message)
            return True
        if method == RuntimeMethod.SESSION_REPLAY:
            try:
                await self._replay(message)
            except Exception as exc:
                await self._respond_error(message, str(exc), type(exc).__name__)
            return True
        if method == RuntimeMethod.SESSION_SWITCH and (self._current_cancel is not None or self._queued_turn_starts):
            await self._respond_error(message, "Cannot switch sessions while a turn is running.", "TurnActive")
            return True
        if method == RuntimeMethod.RIND_GOAL_GET:
            await self._goal_get(message)
            return True
        if method == RuntimeMethod.RIND_GOAL_STATUS:
            await self._goal_status(message)
            return True
        if method == RuntimeMethod.RIND_GOAL_CLEAR:
            await self._goal_clear(message)
            return True
        return False

    async def _list_backgrounds(self, request: dict[str, Any]) -> None:
        if self._background_list is None:
            await self._respond_error(
                request,
                "Background monitoring is unavailable.",
                "UnsupportedOperation",
            )
            return
        try:
            await self._respond(request, await background_list_response(self._background_list, self._session_id()))
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

    async def _background_output_request(self, request: dict[str, Any]) -> None:
        if self._background_output is None:
            await self._respond_error(
                request,
                "Background monitoring is unavailable.",
                "UnsupportedOperation",
            )
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        try:
            response = await background_output_response(self._background_output, self._session_id(), params)
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

    def _session_id(self) -> str:
        return str(getattr(self._session, "session_id", "default") or "default")

    async def _submit_queued_input(self, message: dict[str, Any], submit: Callable[[str], Any]) -> None:
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        text = params.get("input") if isinstance(params.get("input"), str) else ""
        try:
            result = submit(text)
        except InputQueueError as exc:
            await self._respond_error(message, str(exc), exc.error_type)
            return
        if self._input_observer is not None and isinstance(result, dict):
            observed = {**result, "session_id": self._session_id()}
            callback_result = self._input_observer(observed)
            if inspect.isawaitable(callback_result):
                await callback_result
        await self._respond(message, result)

    async def _promote_queued_input(self, message: dict[str, Any]) -> None:
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        input_id = params.get("input_id") if isinstance(params.get("input_id"), str) else ""
        try:
            result = self._runtime.promote_follow_up(input_id)
        except InputQueueError as exc:
            await self._respond_error(message, str(exc), exc.error_type)
            return
        await self._respond(message, result)

    async def _retrieve_queued_input(self, message: dict[str, Any], retrieve: Callable[[str | None], Any]) -> None:
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if "input_id" in params and params.get("input_id") is not None and not isinstance(params.get("input_id"), str):
            await self._respond_error(message, "input_id must be a string.", "InvalidRequest")
            return
        input_id = params.get("input_id") if isinstance(params.get("input_id"), str) else None
        try:
            result = retrieve(input_id)
        except InputQueueError as exc:
            await self._respond_error(message, str(exc), exc.error_type)
            return
        await self._respond(message, result)

    async def _respond_slash_result(self, request: dict[str, Any], result: SlashCommandResult) -> None:
        await self._respond(request, result.to_dict())

    def _interrupt_current(self) -> bool:
        interrupted = False
        discard_inputs = getattr(self._runtime, "discard_pending_inputs", None)
        if callable(discard_inputs):
            discard_inputs()
        if self._current_cancel and not self._current_cancel.token.is_cancelled:
            self._current_cancel.cancel("User interrupted")
            interrupted = True
        for future in self._pending_answers.values():
            if not future.done():
                future.set_result("")
                interrupted = True
        self._pending_answers.clear()
        return interrupted

    async def _receive_user_answer(self, message: dict[str, Any]) -> None:
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        tool_call_id = str(params.get("tool_call_id") or "")
        answer = str(params.get("answer") or "").strip()
        future = self._pending_answers.get(tool_call_id)
        if future is None:
            await self._respond_error(message, "No pending user question.", "QuestionNotFound")
            return
        if not future.done():
            future.set_result(answer)
        await self._respond(message, {"ok": True})

    def _prepare_user_question(self, tool_call_id: str) -> None:
        value = str(tool_call_id or "").strip()
        if value and value not in self._pending_answers:
            self._pending_answers[value] = asyncio.get_running_loop().create_future()

    async def _answer_user_question(self, event: UserQuestionRequestedEvent) -> str:
        future = self._pending_answers.get(event.tool_call_id)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            self._pending_answers[event.tool_call_id] = future
        try:
            return await future
        finally:
            self._pending_answers.pop(event.tool_call_id, None)

    async def _respond(self, request: dict[str, Any], result: Any) -> None:
        await self._writer.send(response_message(request, result))

    async def _respond_error(self, request: dict[str, Any], message: str, error_type: str) -> None:
        await self._writer.send(error_message(request, message, error_type))

    async def _send_event(self, event: dict[str, Any]) -> None:
        session_id = self._session_id()
        event_session_id = str(event.get("session_id") or "")
        if event_session_id != session_id:
            event = {**event, "session_id": session_id}
        if event.get("type") == "user_question_requested":
            self._prepare_user_question(str(event.get("tool_call_id") or ""))
        if self._event_observer is not None:
            callback_result = self._event_observer(event)
            if inspect.isawaitable(callback_result):
                await callback_result
        self._sequence += 1
        await self._writer.send(event_envelope(event, self._sequence))


class _WorkerWriter:
    def __init__(self, writer: Any | None = None) -> None:
        self._writer = writer or JsonlWriter()
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


class WorkerStdioRuntimeServer:
    """JSONL transport that routes every session request through one worker."""

    worker_mode = True

    def __init__(
        self,
        worker,
        debug: bool = False,
        *,
        background_list: Callable[[str], Any] | None = None,
        background_output: Callable[..., Any] | None = None,
        goal_enabled: bool = True,
        writer: Any | None = None,
    ):
        self._worker = worker
        self._debug = debug
        self._background_list = background_list
        self._background_output = background_output
        self._goal_enabled = goal_enabled
        self._writer = _WorkerWriter(writer)
        self._slash_router = SlashCommandRouter()
        self._requests: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._dispatch_tasks: set[asyncio.Task] = set()
        self._initialized = False
        self._stopping = False
        self._shutdown_request: dict[str, Any] | None = None
        self._shutdown_response_sent = False
        self._subscribed: set[str] = set()
        self._remove_event_sink: Callable[[], None] | None = None
        add_event_sink = getattr(self._worker.execution, "add_event_sink", None)
        if callable(add_event_sink):
            self._remove_event_sink = add_event_sink(self._send_event)
        else:
            set_event_sink = getattr(self._worker.execution, "set_event_sink", None)
            if callable(set_event_sink):
                set_event_sink(self._send_event)

    def close(self) -> None:
        """Unregister this connection's sink and close the writer."""
        remover = self._remove_event_sink
        self._remove_event_sink = None
        if remover is not None:
            remover()
        self._writer.close()

    async def run(self) -> int:
        self._start_stdin_pump()
        return await self._serve()

    async def dispatch(self, request: dict[str, Any]) -> None:
        await self._dispatch(request)

    def schedule(self, request: dict[str, Any]) -> None:
        self._schedule_dispatch(request)

    def _start_stdin_pump(self) -> None:
        loop = asyncio.get_running_loop()

        def _pump() -> None:
            while not self._stopping:
                line = sys.stdin.readline()
                if line == "":
                    break
                asyncio.run_coroutine_threadsafe(self._ingest_line(line), loop).result()
            asyncio.run_coroutine_threadsafe(self._ingest_eof(), loop).result()

        threading.Thread(target=_pump, name="rind-stdin-pump", daemon=True).start()

    async def _ingest_eof(self) -> None:
        await self._requests.put(None)

    async def _serve(self) -> int:
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
            if method in {RuntimeMethod.SESSION_SUBSCRIBE, RuntimeMethod.SESSION_UNSUBSCRIBE}:
                await self._subscription_request(request)
                return
            if method == RuntimeMethod.MODEL_LIST:
                await self._list_models(request)
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

    async def _initialize(self, request: dict[str, Any]) -> None:
        info = await self._worker.initialize()
        session_id = str(info.get("session_id") or "")
        if session_id:
            self._subscribed.add(session_id)
        result = {
            "session_id": info["session_id"],
            "draft": False,
            "model": info.get("model"),
            "reasoning_effort": info.get("reasoning_effort"),
            "base_url": info.get("base_url"),
            "workspace_root": info.get("workspace_root"),
            "version": __version__,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": self._capabilities(),
            "methods": self._methods(),
            "resume_preview": "" if info.get("message_count", 0) <= 1 else await self._resume_preview(info["session_id"]),
            "turn_state": info.get("turn_state"),
            "live_turn": info.get("live_turn"),
            "commands": self._slash_command_infos(),
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
        owns_execution = container is None
        if owns_execution:
            container = await self._worker.start_execution(session_id)
        try:
            if container.runtime.turn_active:
                await self._respond_error(request, "Cannot compact context while a turn is active.", "TurnActive")
                return
            await self._respond(request, await container.runtime.compact_context(reason="manual"))
        finally:
            if owns_execution:
                await self._worker.release_execution(session_id)

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
        settings = await self._worker.repository.settings_for(session_id)
        validate_settings(settings)
        client = OpenAIClientFactory(settings).create_async_client()
        try:
            models = await fetch_model_ids(client)
        finally:
            await close_async_client(client)
        default_model = settings.model
        current_model = str(info.get("model") or default_model)
        await self._respond(
            request,
            {
                "models": merge_models(models, current_model),
                "current_model": current_model,
                "default_model": default_model,
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
        replay = getattr(self._worker, "replay", None)
        if callable(replay):
            result = await replay(session_id, start=start, end=end)
        else:
            result = await self._worker.repository.replay(session_id, start=start, end=end)
        await self._respond(request, result)

    async def _replay_event_pages(self, request: dict[str, Any], after_cursor: int) -> None:
        session_id = await self._required_session_id(request)
        if session_id is None:
            return
        loader = getattr(self._worker, "replay_event_pages", None)
        if not callable(loader):
            await self._respond_error(request, "Incremental replay is unavailable.", "UnsupportedOperation")
            return
        materials = await loader(session_id)
        messages = materials.get("messages") if isinstance(materials.get("messages"), list) else []
        tool_records = materials.get("tool_records") if isinstance(materials.get("tool_records"), list) else []
        events = project_durable_events(messages, tool_records, materials.get("turn_state"), session_id)
        envelopes = [event_envelope(event, index + 1) for index, event in enumerate(events)]
        await self._respond(request, {"events": envelopes[after_cursor:], "cursor": len(events)})

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
        needs_execution = command in {"compact", "team"}
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
        model = str(params.get("model") or "").strip()
        if not model:
            await self._respond_error(request, "model/set requires model.", "InvalidRequest")
            return
        active = self._worker.execution.active_container(session_id)
        if active is not None:
            result = await set_active_model(active.runtime, active.session_store, model)
            await self._respond(request, result)
            return
        store = await self._worker.repository.open_store(session_id, persist_system_prompt=False)
        await self._respond(request, await set_active_model(None, store, model))

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
        if active is not None:
            result = await set_active_reasoning_effort(active.runtime, active.session_store, effort)
            await self._respond(request, result)
            return
        store = await self._worker.repository.open_store(session_id, persist_system_prompt=False)
        await self._respond(request, await set_active_reasoning_effort(None, store, effort))

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

    async def _ingest_line(self, line: str) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            await self._respond_error({}, "Invalid JSON request.", "ParseError")
            return
        if not isinstance(message, dict):
            await self._respond_error({}, "JSONL request must be an object.", "ParseError")
            return
        request_error = validate_request(message)
        if request_error is not None:
            await self._respond_error(message, request_error, "InvalidRequest")
            return
        await self._requests.put(message)

    async def _respond(self, request: dict[str, Any], result: Any) -> None:
        await self._writer.send(response_message(request, result))

    async def _respond_slash_result(self, request: dict[str, Any], result: SlashCommandResult) -> None:
        await self._respond(request, result.to_dict())

    async def _respond_error(self, request: dict[str, Any], message: str, error_type: str) -> None:
        await self._writer.send(error_message(request, message, error_type))
