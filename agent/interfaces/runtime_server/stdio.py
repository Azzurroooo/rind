"""JSONL stdio adapter for the headless Rind runtime."""

from __future__ import annotations

import asyncio
import inspect
import json
import signal
import sys
from collections.abc import Callable
from typing import Any

from agent.application.runtime import InputQueueError
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import UserQuestionRequestedEvent
from agent.infrastructure.paths import validate_session_id
from agent.interfaces.cli.commands import SlashCommandContext, SlashCommandResult, SlashCommandRouter
from agent.interfaces.cli.commands.model_control import set_active_model
from agent.interfaces.cli.ui.resume_preview import render_resume_preview
from agent.interfaces.runtime_server.protocol import (
    CAPABILITIES,
    PROTOCOL_VERSION,
    error_message,
    event_envelope,
    response_message,
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


class StdioRuntimeServer:
    def __init__(
        self,
        runtime,
        session,
        debug: bool = False,
        *,
        model_client_factory: Callable[[], Any] | None = None,
        default_model: str = "",
        background_list: Callable[[str], Any] | None = None,
        background_output: Callable[..., Any] | None = None,
        goal_enabled: bool = False,
    ):
        self._runtime = runtime
        self._session = session
        self._debug = debug
        self._model_client_factory = model_client_factory
        self._default_model = str(default_model or "").strip()
        self._background_list = background_list
        self._background_output = background_output
        self._goal_enabled = bool(goal_enabled)
        self._slash_router = SlashCommandRouter()
        self._writer = JsonlWriter()
        self._requests: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._pending_answers: dict[str, asyncio.Future[str]] = {}
        self._current_cancel: CancellationTokenSource | None = None
        self._initialized = False
        self._sequence = 0
        self._stopping = False
        self._shutdown_request: dict[str, Any] | None = None
        self._shutdown_response_sent = False
        self._install_question_responder()

    async def run(self) -> int:
        reader = asyncio.create_task(self._read_stdin())
        try:
            return await self._serve()
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    def _install_question_responder(self) -> None:
        set_responder = getattr(self._runtime, "set_user_question_responder", None)
        if callable(set_responder):
            set_responder(self._answer_user_question)

    async def _serve(self) -> int:
        while True:
            request = await self._requests.get()
            if request is None:
                await self._respond_to_shutdown()
                return 0
            method = str(request.get("method") or "")
            if method == "shutdown":
                self._begin_shutdown(request)
                continue
            if self._stopping:
                await self._respond_error(
                    request,
                    "Runtime is shutting down.",
                    "ServerStopping",
                )
                continue
            await self._dispatch(request)

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
            if method == "initialize":
                await self._initialize(request)
            elif method == "turn.start":
                await self._run_turn(request)
            elif method == "session.replay":
                await self._replay(request)
            elif method == "compact":
                await self._compact(request)
            elif method == "models.list":
                await self._list_models(request)
            elif method == "model.set":
                await self._set_model(request)
            elif method == "session.switch":
                await self._switch_session(request)
            elif method == "background.list":
                await self._list_backgrounds(request)
            elif method == "background.output":
                await self._background_output_request(request)
            elif method == "goal.get":
                await self._goal_get(request)
            elif method == "goal.set":
                await self._goal_set(request)
            elif method == "goal.status":
                await self._goal_status(request)
            elif method == "goal.clear":
                await self._goal_clear(request)
            elif method == "slash.execute":
                await self._execute_slash(request)
            else:
                await self._respond_error(request, f"Unknown method: {method}", "MethodNotFound")
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

    async def _initialize(self, request: dict[str, Any]) -> None:
        await self._runtime.initialize()
        self._initialized = True
        result = {
            "session_id": getattr(self._session, "session_id", None),
            "model": getattr(self._session, "model", None),
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": self._capabilities(),
            "resume_preview": await self._resume_preview(),
            "slash_commands": self._slash_command_infos(),
        }
        if self._goal_enabled:
            result["goal"] = await self._runtime.get_goal()
        await self._respond(
            request,
            result,
        )

    def _capabilities(self) -> list[str]:
        capabilities = list(CAPABILITIES)
        if self._background_list is None or self._background_output is None:
            capabilities.remove("background_monitor")
        if self._goal_enabled:
            capabilities.append("goals")
        return capabilities

    def _slash_command_infos(self) -> list[dict[str, Any]]:
        return [
            {
                "name": info.name,
                "description": info.description,
                "usage": info.usage,
                "aliases": list(info.aliases),
            }
            for info in self._slash_router.command_infos()
        ]

    async def _resume_preview(self) -> str:
        get_messages = getattr(self._session, "get_messages_slice", None)
        if not callable(get_messages):
            return ""
        messages = await get_messages()
        return render_resume_preview(messages, session_id=getattr(self._session, "session_id", None))

    async def _turn_state(self) -> dict[str, Any] | None:
        get_state = getattr(self._session, "get_turn_state", None)
        if not callable(get_state):
            return None
        state = await get_state()
        return dict(state) if isinstance(state, dict) else None

    async def _replay(self, request: dict[str, Any]) -> None:
        get_messages = getattr(self._session, "get_messages_slice", None)
        if not callable(get_messages):
            await self._respond(request, {"messages": [], "turn_state": await self._turn_state()})
            return
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        start = params.get("start") if isinstance(params.get("start"), int) else None
        end = params.get("end") if isinstance(params.get("end"), int) else None
        if start is None and end is None:
            messages = await get_messages()
        else:
            messages = await get_messages(start=start, end=end)
        await self._respond(request, {"messages": messages, "turn_state": await self._turn_state()})

    async def _run_turn(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_query = params.get("input")
        if raw_query is None:
            raw_query = params.get("query")
        query = str(raw_query or "")
        goal_continuation = params.get("goal_continuation") is True
        if not query.strip() and not goal_continuation:
            await self._respond_error(request, "turn.start requires input.", "InvalidRequest")
            return
        if goal_continuation:
            if not self._goal_enabled:
                await self._respond_error(request, "Goal support is unavailable.", "UnsupportedOperation")
                return
            goal = await self._runtime.get_goal()
            if not goal or goal.get("status") != "active":
                await self._respond_error(request, "No active goal to continue.", "InvalidRequest")
                return
        transient_system_messages = params.get("transient_system_messages")
        if not isinstance(transient_system_messages, list):
            transient_system_messages = None

        cancel_source = CancellationTokenSource()
        self._current_cancel = cancel_source
        turn_session_id = ""
        turn_id = ""
        try:
            async for event in self._runtime.run_turn(
                query=query,
                cancellation_token=cancel_source.token,
                transient_system_messages=transient_system_messages,
            ):
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
            self._current_cancel = None
            cancel_source.dispose()

    async def _compact(self, request: dict[str, Any]) -> None:
        record = await self._runtime.compact_context(reason="manual")
        await self._respond(request, record)

    async def _list_models(self, request: dict[str, Any]) -> None:
        if self._model_client_factory is None:
            raise RuntimeError("Model listing is unavailable.")
        client = self._model_client_factory()
        try:
            models = await self._fetch_model_ids(client)
            current_model = self._current_model()
            default_model = self._default_model
            merged = self._merge_models(models, current_model)
        finally:
            await self._close_client(client)
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
            await self._respond_error(request, "model.set requires model.", "InvalidRequest")
            return
        result = await set_active_model(self._runtime, self._session, model)
        await self._respond(request, result)

    async def _switch_session(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_session_id = params.get("session_id")
        if not isinstance(raw_session_id, str) or not raw_session_id.strip():
            await self._respond_error(request, "session.switch requires session_id.", "InvalidRequest")
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
            await self._respond_error(request, "goal.set requires objective.", "InvalidRequest")
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
            await self._respond_error(request, "goal.status requires active or paused.", "InvalidRequest")
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

    async def _fetch_model_ids(self, client: Any) -> list[str]:
        response = client.models.list()
        if hasattr(response, "__aiter__"):
            return [self._model_id(item) async for item in response]
        if inspect.isawaitable(response):
            response = await response
        data = getattr(response, "data", response)
        if hasattr(data, "__aiter__"):
            return [self._model_id(item) async for item in data]
        if not isinstance(data, list | tuple):
            try:
                data = list(data)
            except TypeError:
                data = []
        return [self._model_id(item) for item in data]

    def _current_model(self) -> str:
        session_model = str(getattr(self._session, "model", "") or "").strip()
        return session_model or self._default_model

    def _merge_models(self, models: list[str], current_model: str) -> list[str]:
        seen: set[str] = set()
        merged: list[str] = []
        current_found = False
        for model in sorted(model for model in models if model):
            if model in seen:
                continue
            seen.add(model)
            current_found = current_found or model == current_model
            merged.append(model)
        if current_model and not current_found:
            merged.insert(0, current_model)
        return merged

    def _model_id(self, item: Any) -> str:
        if isinstance(item, dict):
            return str(item.get("id") or "").strip()
        return str(getattr(item, "id", "") or "").strip()

    async def _close_client(self, client: Any) -> None:
        close = getattr(client, "close", None)
        if not callable(close):
            return
        result = close()
        if inspect.isawaitable(result):
            await result

    async def _execute_slash(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_input = str(params.get("input") or "")
        cancel_source = CancellationTokenSource()
        self._current_cancel = cancel_source
        try:
            result = await self._slash_router.execute(
                raw_input,
                SlashCommandContext(
                    runtime=self._runtime,
                    session=self._session,
                    debug=self._debug,
                    cancellation_token=cancel_source.token,
                ),
            )
            await self._respond_slash_result(request, result)
        except asyncio.CancelledError:
            if not cancel_source.token.is_cancelled:
                raise
            await self._respond(
                request,
                {
                    "text": "Compact cancelled.",
                    "should_exit": False,
                    "clear_screen": False,
                    "input_prefill": "",
                    "run_turn_input": "",
                    "transient_system_messages": None,
                    "context_usage_reset": False,
                    "display": None,
                },
            )
        finally:
            self._current_cancel = None
            cancel_source.dispose()

    async def _read_stdin(self) -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if line == "":
                self._begin_shutdown()
                return
            message, parse_error = self._parse_line(line)
            if parse_error is not None:
                await self._respond_error({}, parse_error, "ParseError")
                continue
            request_error = self._validate_request(message)
            if request_error is not None:
                await self._respond_error(message, request_error, "InvalidRequest")
                continue
            if await self._handle_control_message(message):
                continue
            await self._requests.put(message)

    def _parse_line(self, line: str) -> tuple[dict[str, Any], str | None]:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            return {}, "Invalid JSON request."
        if not isinstance(value, dict):
            return {}, "JSONL request must be an object."
        return value, None

    def _validate_request(self, request: dict[str, Any]) -> str | None:
        request_id = request.get("request_id")
        if isinstance(request_id, bool) or request_id is None:
            return "request_id is required."
        if isinstance(request_id, str) and not request_id.strip():
            return "request_id must not be empty."
        if not isinstance(request_id, str | int | float):
            return "request_id must be a string or number."
        method = request.get("method")
        if not isinstance(method, str) or not method.strip():
            return "method is required."
        params = request.get("params")
        if params is not None and not isinstance(params, dict):
            return "params must be an object."
        return None

    async def _handle_control_message(self, message: dict[str, Any]) -> bool:
        method = str(message.get("method") or "")
        if method == "shutdown":
            if not self._begin_shutdown(message):
                await self._respond_error(message, "Runtime is shutting down.", "ServerStopping")
            return True
        if method == "turn.steer":
            await self._submit_queued_input(message, self._runtime.submit_steering)
            return True
        if method == "turn.follow_up":
            await self._submit_queued_input(message, self._runtime.submit_follow_up)
            return True
        if method == "turn.interrupt":
            if not self._interrupt_current():
                await self._respond_error(message, "No active turn to interrupt.", "TurnNotActive")
                return True
            await self._respond(message, {"ok": True})
            return True
        if method == "user_question.respond":
            await self._receive_user_answer(message)
            return True
        if method == "background.list":
            await self._list_backgrounds(message)
            return True
        if method == "background.output":
            await self._background_output_request(message)
            return True
        if method == "goal.get":
            await self._goal_get(message)
            return True
        if method == "goal.status":
            await self._goal_status(message)
            return True
        if method == "goal.clear":
            await self._goal_clear(message)
            return True
        if method == "slash.execute" and self._initialized and self._is_readonly_slash_request(message):
            await self._execute_readonly_slash(message)
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
            tasks = self._background_list(self._session_id())
            if inspect.isawaitable(tasks):
                tasks = await tasks
            if not isinstance(tasks, list):
                raise TypeError("Background list must be a list.")
            await self._respond(request, {"tasks": tasks})
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
        bg_id = params.get("bg_id")
        if not isinstance(bg_id, str) or not bg_id.strip():
            await self._respond_error(request, "background.output requires bg_id.", "InvalidRequest")
            return
        max_output_chars = params.get("max_output_chars", 20000)
        if isinstance(max_output_chars, bool) or not isinstance(max_output_chars, int):
            await self._respond_error(
                request,
                "background.output max_output_chars must be an integer.",
                "InvalidRequest",
            )
            return
        try:
            task = self._background_output(
                bg_id.strip(),
                max_output_chars=max_output_chars,
                _session_id=self._session_id(),
            )
            if inspect.isawaitable(task):
                task = await task
            if not isinstance(task, dict):
                raise TypeError("Background output must be an object.")
            await self._respond(request, {"task": task})
        except LookupError as exc:
            await self._respond_error(request, str(exc), "NotFound")
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

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
        await self._respond(message, result)

    def _is_readonly_slash_request(self, message: dict[str, Any]) -> bool:
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        raw_input = str(params.get("input") or "").strip()
        try:
            name, _args = self._slash_router._parse(raw_input)
        except ValueError:
            return False
        return name in {"status", "doctor"}

    async def _execute_readonly_slash(self, request: dict[str, Any]) -> None:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        raw_input = str(params.get("input") or "")
        try:
            result = await self._slash_router.execute(
                raw_input,
                SlashCommandContext(
                    runtime=self._runtime,
                    session=self._session,
                    debug=self._debug,
                    cancellation_token=None,
                ),
            )
            await self._respond_slash_result(request, result)
        except Exception as exc:
            await self._respond_error(request, str(exc), type(exc).__name__)

    async def _respond_slash_result(self, request: dict[str, Any], result: SlashCommandResult) -> None:
        await self._respond(
            request,
            {
                "text": result.text,
                "should_exit": result.should_exit,
                "clear_screen": result.clear_screen,
                "input_prefill": result.input_prefill,
                "run_turn_input": result.run_turn_input,
                "transient_system_messages": result.transient_system_messages,
                "context_usage_reset": result.context_usage_reset,
                "display": result.display,
            },
        )

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
        future = self._pending_answers.pop(tool_call_id, None)
        if future is None:
            await self._respond_error(message, "No pending user question.", "QuestionNotFound")
            return
        if not future.done():
            future.set_result(answer)
        await self._respond(message, {"ok": True})

    async def _answer_user_question(self, event: UserQuestionRequestedEvent) -> str:
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
        self._sequence += 1
        await self._writer.send(event_envelope(event, self._sequence))


def main(argv: list[str] | None = None) -> int:
    from agent.interfaces.runtime_server.app_server import main as app_server_main

    return app_server_main(argv, server_class=StdioRuntimeServer)


if __name__ == "__main__":
    raise SystemExit(main())
