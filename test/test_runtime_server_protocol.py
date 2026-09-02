import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.runtime.core import InputQueueError
from agent.runtime.server.stdio import (
    JsonlWriter,
    StdioRuntimeServer,
    configure_stdio_server_signals,
    configure_utf8_stdio,
)
from agent.runtime.server.commands import SlashCommandInfo, SlashCommandRouter
from agent.runtime.server.protocol import CAPABILITIES, CORE_METHODS, RuntimeMethod, event_envelope, validate_request
from agent.infrastructure.config import Config


class _Runtime:
    def __init__(self):
        self.model = None

    def set_user_question_responder(self, responder):
        self.responder = responder

    async def initialize(self):
        return None

    async def set_model(self, model):
        self.model = model
        return {"runtime": True, "session": False}

    async def compact_context(self, reason="manual", cancellation_token=None):
        return {
            "id": "compact-1",
            "source": {
                "message_start_index": 1,
                "message_end_index_exclusive": 3,
                "tool_call_ids": ["tool-1"],
            },
        }


class _Session:
    session_id = "s1"
    model = "m1"


class _Model:
    def __init__(self, model_id):
        self.id = model_id


class _AsyncModelList:
    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        self._iter = iter(self._items)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


def _turn_event(event_type: str, turn_id: str = "t1"):
    return type(
        "Event",
        (),
        {
            "to_dict": lambda _self: {
                "type": event_type,
                "ts": "1700000000.0",
                "session_id": "s1",
                "turn_id": turn_id,
            }
        },
    )()


class _BlockingTurnRuntime(_Runtime):
    """Runtime whose turn blocks until released, mirroring a long-running turn."""

    def __init__(self):
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def run_turn(self, **_kwargs):
        self.started.set()
        await self.release.wait()
        yield _turn_event("turn_completed")


def _trace_responses(server: StdioRuntimeServer, responses: list) -> None:
    writer_send = server._writer.send

    async def trace_send(payload: dict) -> None:
        await writer_send(payload)
        if payload.get("kind") == "response":
            responses.append(payload)

    server._writer.send = trace_send


async def _await_response(responses: list, request_id, timeout: float = 10.0) -> None:
    async def poll() -> None:
        while not any(message.get("request_id") == request_id for message in responses):
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


def test_question_response_completes_pending_future():
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        event = type("Event", (), {"tool_call_id": "call-1"})()
        task = asyncio.create_task(server._answer_user_question(event))
        await asyncio.sleep(0)
        await server._receive_user_answer(
            {"request_id": 1, "method": "rind/user-question/respond", "params": {"tool_call_id": "call-1", "answer": "yes"}}
        )
        return await task

    assert asyncio.run(run()) == "yes"


def test_question_response_before_responder_registration_is_replayed():
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._prepare_user_question("call-early")
        await server._receive_user_answer(
            {"request_id": 2, "method": "rind/user-question/respond", "params": {"tool_call_id": "call-early", "answer": "yes"}}
        )
        event = type("Event", (), {"tool_call_id": "call-early"})()
        return await server._answer_user_question(event)

    assert asyncio.run(run()) == "yes"


def test_jsonl_writer_uses_compact_json(capsys):
    async def run():
        await JsonlWriter().send({"kind": "event", "event": {"type": "turn_completed"}})

    asyncio.run(run())
    assert capsys.readouterr().out == '{"kind":"event","event":{"type":"turn_completed"}}\n'


def test_runtime_events_use_versioned_envelope(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._send_event(
            {
                "type": "assistant_delta",
                "ts": "1700000000.0",
                "session_id": "s1",
                "turn_id": "t1",
                "text": "hello",
            }
        )
        await server._send_event(
            {
                "type": "turn_completed",
                "ts": "1700000001.0",
                "session_id": "s1",
                "turn_id": "t1",
            }
        )

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [message["sequence"] for message in messages] == [1, 2]
    assert messages[0]["method"] == RuntimeMethod.SESSION_UPDATE
    assert messages[0]["durability"] == "incremental"
    assert messages[0]["session_id"] == "s1"
    assert messages[0]["turn_id"] == "t1"
    assert messages[0]["event"]["text"] == "hello"


def test_runtime_event_session_identity_is_bound_to_server_session(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._send_event({"type": "assistant_delta", "session_id": "other", "turn_id": "t1", "text": "hello"})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["session_id"] == "s1"
    assert message["event"]["session_id"] == "s1"


def test_golden_event_fixture_matches_python_envelope():
    fixture = PROJECT_ROOT / "test" / "fixtures" / "runtime_protocol.golden.jsonl"
    messages = [json.loads(line) for line in fixture.read_text(encoding="utf-8").splitlines()]
    events = [message for message in messages if message["kind"] == "event"]
    responses = [message for message in messages if message["kind"] == "response"]

    assert [event_envelope(message["event"], message["sequence"]) for message in events] == events
    assert [message["sequence"] for message in events] == [1, 2, 3, 4, 5]
    assert responses == [
        {
            "kind": "response",
            "request_id": "turn-1",
            "result": {"ok": True, "session_id": "session-1", "turn_id": "turn-1"},
        },
        {
            "kind": "response",
            "request_id": "interrupt-2",
            "error": {"type": "TurnNotActive", "message": "No active turn to interrupt."},
        },
    ]


def test_event_envelope_separates_durable_and_incremental_events():
    assert event_envelope({"type": "assistant_delta"}, 1)["durability"] == "incremental"
    assert event_envelope({"type": "tool_input_delta"}, 2)["durability"] == "incremental"
    assert event_envelope({"type": "queued_input_delivered"}, 3)["durability"] == "incremental"
    assert event_envelope({"type": "tool_result"}, 2)["durability"] == "durable"


def test_request_validation_requires_the_standard_envelope() -> None:
    assert validate_request({"kind": "request", "request_id": 1, "method": "initialize"}) is None
    assert validate_request({"request_id": 1, "method": "initialize"}) == 'kind must be "request".'
    assert validate_request({"kind": "request", "request_id": None, "method": "initialize"}) == "request_id is required."
    assert validate_request({"kind": "request", "request_id": 1, "method": "", "params": {}}) == "method is required."
    assert validate_request({"kind": "request", "request_id": 1, "method": "initialize", "params": []}) == "params must be an object."


def test_turn_response_contains_session_and_turn_ids(capsys):
    class Runtime(_Runtime):
        async def run_turn(self, **_kwargs):
            yield type(
                "Event",
                (),
                {
                    "to_dict": lambda _self: {
                        "type": "turn_started",
                        "ts": "1700000000.0",
                        "session_id": "s1",
                        "turn_id": "t1",
                    }
                },
            )()

    async def run():
        server = StdioRuntimeServer(Runtime(), _Session())
        await server._run_turn({"request_id": 21, "method": "session/prompt", "params": {"input": "hello"}})

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["method"] == RuntimeMethod.SESSION_UPDATE
    assert messages[1]["request_id"] == 21
    assert messages[1]["result"] == {"ok": True, "session_id": "s1", "turn_id": "t1"}


def test_turn_start_preserves_original_input_text(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.received_query = None

        async def run_turn(self, **kwargs):
            self.received_query = kwargs["query"]
            yield type(
                "Event",
                (),
                {
                    "to_dict": lambda _self: {
                        "type": "turn_completed",
                        "session_id": "s1",
                        "turn_id": "t1",
                    }
                },
            )()

    runtime = Runtime()

    async def run():
        server = StdioRuntimeServer(runtime, _Session())
        await server._run_turn(
            {
                "request_id": 23,
                "method": "session/prompt",
                "params": {"input": "  preserve surrounding text  "},
            }
        )

    asyncio.run(run())

    assert runtime.received_query == "  preserve surrounding text  "


def test_goal_continuation_allows_empty_turn_input(capsys):
    class Runtime(_Runtime):
        async def get_goal(self):
            return {"objective": "finish the release", "status": "active"}

        async def run_turn(self, **_kwargs):
            yield type(
                "Event",
                (),
                {
                    "to_dict": lambda _self: {
                        "type": "turn_completed",
                        "session_id": "s1",
                        "turn_id": "goal-turn",
                    }
                },
            )()

    async def run():
        server = StdioRuntimeServer(Runtime(), _Session(), goal_enabled=True)
        await server._run_turn(
            {
                "request_id": 22,
                "method": "session/prompt",
                "params": {"input": "", "goal_continuation": True},
            }
        )

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[-1]["result"] == {"ok": True, "session_id": "s1", "turn_id": "goal-turn"}


def test_initialize_response_includes_resume_preview_when_history_exists(capsys):
    class Session:
        session_id = "s1"
        model = "m1"

        async def get_messages_slice(self, compacted=True):
            return [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi"},
            ]

    async def run():
        server = StdioRuntimeServer(_Runtime(), Session())
        await server._initialize({"request_id": 7, "method": "initialize", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    result = message["result"]
    assert message["request_id"] == 7
    assert result["protocol_version"] == "2"
    assert result["version"] == "0.6.1"
    assert result["capabilities"] == list(CAPABILITIES)
    assert result["methods"] == list(CORE_METHODS)
    assert result["session_id"] == "s1"
    assert result["model"] == "m1"
    assert "Resumed session s1" in result["resume_preview"]
    assert "- user: hello" in result["resume_preview"]
    assert any(command["name"] == "status" for command in result["commands"])


def test_session_prompt_resume_passes_recovery_flag_without_input(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.run_kwargs = None

        async def run_turn(self, **kwargs):
            self.run_kwargs = kwargs
            yield _turn_event("turn_completed", "recover-turn")

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        await server._run_turn({"request_id": 8, "method": "session/prompt", "params": {"resume": True}})
        return runtime

    runtime = asyncio.run(run())
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[-1]["result"]["ok"] is True
    assert runtime.run_kwargs["resume"] is True
    assert runtime.run_kwargs["query"] == ""


def test_initialize_goal_capability_returns_session_goal(capsys):
    class Runtime(_Runtime):
        async def get_goal(self):
            return {"objective": "finish the release", "status": "active"}

    async def run():
        server = StdioRuntimeServer(Runtime(), _Session(), goal_enabled=True)
        await server._initialize({"request_id": 9, "method": "initialize", "params": {}})

    asyncio.run(run())

    result = json.loads(capsys.readouterr().out)["result"]
    assert "rind/goals" in result["capabilities"]
    assert result["goal"] == {"objective": "finish the release", "status": "active"}


def test_initialize_exposes_only_the_registered_command_catalog(capsys):
    async def handle_custom(_context, _args):
        return "custom"

    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._slash_router = SlashCommandRouter(
            (SlashCommandInfo("custom", "Custom command", "/custom", handler=handle_custom),)
        )
        await server._initialize({"request_id": 10, "method": "initialize", "params": {}})

    asyncio.run(run())

    result = json.loads(capsys.readouterr().out)["result"]
    assert result["commands"] == [
        {"name": "custom", "description": "Custom command", "usage": "/custom", "aliases": []}
    ]


def test_goal_control_requests_update_and_clear_state(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.goal = None

        async def get_goal(self):
            return self.goal

        async def set_goal(self, objective):
            self.goal = {"objective": objective, "status": "active"}
            return self.goal

        async def set_goal_status(self, status):
            self.goal["status"] = status
            return self.goal

        async def clear_goal(self):
            self.goal = None

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session(), goal_enabled=True)
        await server._goal_set({"request_id": 10, "params": {"objective": "ship it"}})
        await server._goal_status({"request_id": 11, "params": {"status": "paused"}})
        await server._goal_clear({"request_id": 12, "params": {}})

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["result"]["goal"] == {"objective": "ship it", "status": "active"}
    assert messages[1]["result"]["goal"]["status"] == "paused"
    assert messages[2]["result"]["goal"] is None


def test_session_replay_returns_projected_messages_and_turn_state(capsys):
    class Session(_Session):
        async def get_messages_slice(self, start=None, end=None, compacted=True):
            return [{"role": "user", "content": "hello"}][slice(start, end)]

        async def get_turn_state(self):
            return {"turn_id": "t1", "status": "completed", "ts": "now"}

    async def run():
        server = StdioRuntimeServer(_Runtime(), Session())
        await server._replay({"request_id": 23, "method": "session/replay", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"] == {
        "messages": [{"role": "user", "content": "hello"}],
        "turn_state": {"turn_id": "t1", "status": "completed", "ts": "now"},
        "model": "m1",
    }


def test_session_switch_returns_target_metadata_and_preview(capsys):
    class Runtime(_Runtime):
        async def switch_session(self, session_id):
            self.switched = session_id
            return {
                "session_id": session_id,
                "model": "target-model",
                "usage": {"context_usage_percent": 0.4},
                "assistant_usage": {"context_usage_percent": 0.3},
            }

    class Session(_Session):
        async def get_messages_slice(self, compacted=True):
            return [{"role": "user", "content": "target history"}]

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, Session(), default_model="default-model")
        await server._switch_session(
            {"request_id": 24, "method": "session/switch", "params": {"session_id": "target"}}
        )
        return server

    server = asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"]["session_id"] == "target"
    assert message["result"]["model"] == "target-model"
    assert message["result"]["usage"] == {"context_usage_percent": 0.3}
    assert "target history" in message["result"]["resume_preview"]
    assert server._default_model == "default-model"


def test_session_switch_rejects_invalid_request_and_unsupported_runtime(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._dispatch(
            {"request_id": 25, "method": "session/switch", "params": {}}
        )
        await server._dispatch(
            {"request_id": 26, "method": "session/switch", "params": {"session_id": "target"}}
        )

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["error"]["type"] == "InvalidRequest"
    assert messages[1]["error"]["type"] == "UnsupportedOperation"


def test_session_list_returns_recent_sessions_and_current_id(capsys):
    class Session(_Session):
        async def list_recent_sessions(self, limit=10):
            assert limit == 3
            return [{"id": "session-1", "title": "First"}]

    async def run():
        server = StdioRuntimeServer(_Runtime(), Session())
        await server._dispatch(
            {"request_id": 27, "method": "session/list", "params": {"limit": 3}}
        )

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"] == {
        "sessions": [{"id": "session-1", "title": "First"}],
        "current_session_id": "s1",
    }


def test_session_new_returns_new_metadata_and_preview(capsys):
    class Runtime(_Runtime):
        async def create_session(self):
            return {"session_id": "new-session", "model": "new-model"}

    class Session(_Session):
        async def get_messages_slice(self, compacted=True):
            return []

    async def run():
        server = StdioRuntimeServer(Runtime(), Session())
        await server._dispatch({"request_id": 28, "method": "session/new", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"] == {
        "session_id": "new-session",
        "draft": False,
        "model": "new-model",
        "usage": None,
        "resume_preview": "",
    }


def test_slash_execute_reuses_cli_router(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._execute_slash({"request_id": 8, "method": "rind/command/execute", "params": {"input": "/compact"}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    result = message["result"]
    assert set(result) == {"text"}
    assert result["text"].startswith("Compact complete.")


def test_slash_execute_non_compact_does_not_reset_context_usage(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._execute_slash({"request_id": 14, "method": "rind/command/execute", "params": {"input": "/help"}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"]["display"]["type"] == "help"


@pytest.mark.parametrize(
    ("slash_input", "display_type"),
    [
        ("/status", "status"),
        ("/doctor", "doctor"),
        ("/help", "help"),
    ],
)
def test_serve_answers_slash_commands_while_a_turn_occupies_the_runtime(slash_input, display_type, capsys):
    async def run():
        runtime = _BlockingTurnRuntime()
        server = StdioRuntimeServer(runtime, _Session())
        responses: list[dict] = []
        _trace_responses(server, responses)
        serve = asyncio.create_task(server._serve())
        server._requests.put_nowait(
            {"kind": "request", "request_id": 41, "method": "session/prompt", "params": {"input": "hello"}}
        )
        await runtime.started.wait()
        server._requests.put_nowait(
            {"kind": "request", "request_id": 42, "method": "rind/command/execute", "params": {"input": slash_input}}
        )
        await _await_response(responses, 42)
        runtime.release.set()
        await _await_response(responses, 41)
        server._begin_shutdown()
        return await asyncio.wait_for(serve, 10)

    assert asyncio.run(run()) == 0

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    command = next(message for message in messages if message.get("request_id") == 42)
    prompt = next(message for message in messages if message.get("request_id") == 41)

    assert messages.index(command) < messages.index(prompt)
    assert command["result"]["display"]["type"] == display_type
    assert prompt["result"] == {"ok": True, "session_id": "s1", "turn_id": "t1"}


@pytest.mark.parametrize("slash_input", ["/status", "/doctor", "/help"])
def test_ingested_slash_commands_use_the_control_lane_after_initialize(slash_input, capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._initialized = True
        responses: list[dict] = []
        _trace_responses(server, responses)
        await server._ingest_line(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": 42,
                    "method": "rind/command/execute",
                    "params": {"input": slash_input},
                }
            )
        )
        assert server._requests.empty()
        await _await_response(responses, 42)

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["request_id"] == 42
    assert message["result"]["display"]["type"] in {"status", "doctor", "help"}


def test_ingested_slash_command_bypasses_a_running_turn(capsys):
    async def run():
        runtime = _BlockingTurnRuntime()
        server = StdioRuntimeServer(runtime, _Session())
        server._initialized = True
        responses: list[dict] = []
        _trace_responses(server, responses)
        serve = asyncio.create_task(server._serve())
        await server._ingest_line(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": 41,
                    "method": "session/prompt",
                    "params": {"input": "hello"},
                }
            )
        )
        await runtime.started.wait()
        await server._ingest_line(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": 42,
                    "method": "rind/command/execute",
                    "params": {"input": "/status"},
                }
            )
        )
        await _await_response(responses, 42)
        runtime.release.set()
        await _await_response(responses, 41)
        server._begin_shutdown()
        await asyncio.wait_for(serve, 10)

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    command = next(message for message in messages if message.get("request_id") == 42)
    prompt = next(message for message in messages if message.get("request_id") == 41)
    assert messages.index(command) < messages.index(prompt)
    assert command["result"]["display"]["type"] == "status"


def test_background_requests_use_control_callbacks(capsys):
    async def list_backgrounds(session_id):
        assert session_id == "s1"
        return [{"bg_id": "bg_1", "status": "running"}]

    async def snapshot_background(bg_id, *, max_output_chars, _session_id):
        assert (bg_id, max_output_chars, _session_id) == ("bg_1", 100, "s1")
        return {"bg_id": bg_id, "status": "running", "stdout": "tick"}

    async def run():
        server = StdioRuntimeServer(
            _Runtime(),
            _Session(),
            background_list=list_backgrounds,
            background_output=snapshot_background,
        )
        assert await server._handle_control_message(
            {"request_id": 30, "method": "rind/background/list", "params": {}}
        )
        assert await server._handle_control_message(
            {
                "request_id": 31,
                "method": "rind/background/output",
                "params": {"bg_id": "bg_1", "max_output_chars": 100},
            }
        )

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["result"] == {"tasks": [{"bg_id": "bg_1", "status": "running"}]}
    assert messages[1]["result"]["task"]["stdout"] == "tick"


def test_background_output_rejects_invalid_request(capsys):
    async def run():
        server = StdioRuntimeServer(
            _Runtime(),
            _Session(),
            background_output=lambda *_args, **_kwargs: {},
        )
        await server._handle_control_message(
            {"request_id": 32, "method": "rind/background/output", "params": {"bg_id": ""}}
        )

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["error"]["type"] == "InvalidRequest"


def test_slash_execution_does_not_replace_the_active_turn_cancel_source(capsys):
    async def run():
        runtime = _BlockingTurnRuntime()
        server = StdioRuntimeServer(runtime, _Session())
        turn_task = asyncio.create_task(
            server._run_turn({"kind": "request", "request_id": 43, "method": "session/prompt", "params": {"input": "hello"}})
        )
        await runtime.started.wait()
        await server._execute_slash(
            {"kind": "request", "request_id": 44, "method": "rind/command/execute", "params": {"input": "/status"}}
        )
        cancel_still_registered = server._current_cancel is not None
        runtime.release.set()
        await turn_task
        return cancel_still_registered

    cancel_still_registered = asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]

    assert cancel_still_registered is True
    assert messages[0]["result"]["text"].startswith("```text\nStatus:")
    assert messages[-1]["result"] == {"ok": True, "session_id": "s1", "turn_id": "t1"}


def test_serve_runs_queued_prompts_serially(capsys):
    class Runtime(_BlockingTurnRuntime):
        def __init__(self):
            super().__init__()
            self.started_turns: list[str] = []

        async def run_turn(self, **kwargs):
            self.started_turns.append(str(kwargs.get("query")))
            async for event in super().run_turn(**kwargs):
                yield event

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        responses: list[dict] = []
        _trace_responses(server, responses)
        serve = asyncio.create_task(server._serve())
        server._requests.put_nowait(
            {"kind": "request", "request_id": 45, "method": "session/prompt", "params": {"input": "first"}}
        )
        server._requests.put_nowait(
            {"kind": "request", "request_id": 46, "method": "session/prompt", "params": {"input": "second"}}
        )
        await runtime.started.wait()
        await asyncio.sleep(0.05)
        overlapping_turns = list(runtime.started_turns)
        runtime.release.set()
        await _await_response(responses, 45)
        await _await_response(responses, 46)
        server._begin_shutdown()
        await asyncio.wait_for(serve, 10)
        return overlapping_turns, list(runtime.started_turns)

    overlapping_turns, started_turns = asyncio.run(run())

    assert overlapping_turns == ["first"]
    assert started_turns == ["first", "second"]


def test_turn_input_controls_respond_without_main_queue(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.submitted = []

        def submit_steering(self, text):
            self.submitted.append(("steering", text))
            return {"accepted": True, "input_id": "steer-1", "mode": "steering", "pending": 1}

        def submit_follow_up(self, text):
            self.submitted.append(("follow_up", text))
            return {"accepted": True, "input_id": "follow-1", "mode": "follow_up", "pending": 2}

        def promote_follow_up(self, input_id):
            self.submitted.append(("promote", input_id))
            return {"accepted": True, "input_id": input_id, "mode": "steering", "pending": 1}

        def unsteer(self, input_id=None):
            self.submitted.append(("unsteer", input_id or ""))
            return {"retrieved": True, "input_id": "steer-1", "input": "change direction", "mode": "steering", "pending": 0}

        def dequeue_follow_up(self, input_id=None):
            self.submitted.append(("dequeue_follow_up", input_id or ""))
            return {"retrieved": True, "input_id": "follow-1", "input": "next task", "mode": "follow_up", "pending": 0}

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        steering_handled = await server._handle_control_message(
            {"request_id": 31, "method": "rind/session/steer", "params": {"input": "change direction"}}
        )
        follow_up_handled = await server._handle_control_message(
            {"request_id": 32, "method": "rind/session/follow_up", "params": {"input": "next task"}}
        )
        promote_handled = await server._handle_control_message(
            {"request_id": 33, "method": "rind/session/promote_follow_up", "params": {"input_id": "follow-1"}}
        )
        unsteer_handled = await server._handle_control_message(
            {"request_id": 34, "method": "rind/session/unsteer", "params": {"input_id": "steer-1"}}
        )
        dequeue_handled = await server._handle_control_message(
            {"request_id": 35, "method": "rind/session/dequeue_follow_up", "params": {}}
        )
        return runtime, server, steering_handled, follow_up_handled, promote_handled, unsteer_handled, dequeue_handled

    runtime, server, steering_handled, follow_up_handled, promote_handled, unsteer_handled, dequeue_handled = asyncio.run(run())
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]

    assert steering_handled is True
    assert follow_up_handled is True
    assert promote_handled is True
    assert unsteer_handled is True
    assert dequeue_handled is True
    assert server._requests.empty()
    assert runtime.submitted == [
        ("steering", "change direction"),
        ("follow_up", "next task"),
        ("promote", "follow-1"),
        ("unsteer", "steer-1"),
        ("dequeue_follow_up", ""),
    ]
    assert messages[0]["result"] == {"accepted": True, "input_id": "steer-1", "mode": "steering", "pending": 1}
    assert messages[1]["result"] == {"accepted": True, "input_id": "follow-1", "mode": "follow_up", "pending": 2}
    assert messages[2]["result"] == {"accepted": True, "input_id": "follow-1", "mode": "steering", "pending": 1}
    assert messages[3]["result"] == {"retrieved": True, "input_id": "steer-1", "input": "change direction", "mode": "steering", "pending": 0}
    assert messages[4]["result"] == {"retrieved": True, "input_id": "follow-1", "input": "next task", "mode": "follow_up", "pending": 0}


def test_turn_input_control_rejection_is_structured_protocol_error(capsys):
    class Runtime(_Runtime):
        def submit_steering(self, _text):
            raise InputQueueError("steering queue is full", "InputQueueFull")

        def unsteer(self, _input_id=None):
            raise InputQueueError("No queued steering input is available.", "InputNotPending")

    async def run():
        server = StdioRuntimeServer(Runtime(), _Session())
        return await server._handle_control_message(
            {"request_id": 33, "method": "rind/session/steer", "params": {"input": "change"}}
        )

    assert asyncio.run(run()) is True
    message = json.loads(capsys.readouterr().out)
    assert message["request_id"] == 33
    assert message["error"] == {"type": "InputQueueFull", "message": "steering queue is full"}

    async def retrieve():
        server = StdioRuntimeServer(Runtime(), _Session())
        return await server._handle_control_message(
            {"request_id": 34, "method": "rind/session/unsteer", "params": {}}
        )

    assert asyncio.run(retrieve()) is True
    message = json.loads(capsys.readouterr().out)
    assert message["request_id"] == 34
    assert message["error"] == {"type": "InputNotPending", "message": "No queued steering input is available."}


def test_interrupt_discards_runtime_inputs_without_returning_them(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.discard_calls = 0

        def discard_pending_inputs(self):
            self.discard_calls += 1

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        current = CancellationTokenSource()
        server._current_cancel = current
        handled = await server._handle_control_message(
            {"request_id": 34, "method": "session/cancel", "params": {}}
        )
        cancelled = current.token.is_cancelled
        current.dispose()
        return runtime, handled, cancelled

    runtime, handled, cancelled = asyncio.run(run())
    message = json.loads(capsys.readouterr().out)

    assert handled is True
    assert cancelled is True
    assert runtime.discard_calls == 1
    assert message["result"] == {"ok": True}


def test_turn_input_control_is_handled_while_run_turn_is_blocked(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.submitted = []

        async def run_turn(self, **_kwargs):
            self.started.set()
            await self.release.wait()
            yield type(
                "Event",
                (),
                {
                    "to_dict": lambda _self: {
                        "type": "turn_completed",
                        "ts": "1700000000.0",
                        "session_id": "s1",
                        "turn_id": "t1",
                    }
                },
            )()

        def submit_follow_up(self, text):
            self.submitted.append(text)
            return {"accepted": True, "mode": "follow_up", "pending": 1}

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        turn_task = asyncio.create_task(
            server._run_turn({"request_id": 35, "method": "session/prompt", "params": {"input": "hello"}})
        )
        await runtime.started.wait()
        handled = await server._handle_control_message(
            {"request_id": 36, "method": "rind/session/follow_up", "params": {"input": "continue"}}
        )
        assert not turn_task.done()
        runtime.release.set()
        await turn_task
        return runtime, handled

    runtime, handled = asyncio.run(run())
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]

    assert handled is True
    assert runtime.submitted == ["continue"]
    assert messages[0]["request_id"] == 36
    assert messages[0]["result"]["mode"] == "follow_up"


def test_readonly_session_replay_is_handled_while_run_turn_is_blocked(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def run_turn(self, **_kwargs):
            self.started.set()
            await self.release.wait()
            yield type(
                "Event",
                (),
                {
                    "to_dict": lambda _self: {
                        "type": "turn_completed",
                        "ts": "1700000000.0",
                        "session_id": "s1",
                        "turn_id": "t1",
                    }
                },
            )()

    class Session(_Session):
        async def get_messages_for_session(self, session_id, start=None, end=None, compacted=True):
            assert session_id == "archived"
            assert start is None
            assert end is None
            return [{"role": "user", "content": "archived history"}]

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, Session())
        turn_task = asyncio.create_task(
            server._run_turn({"request_id": 37, "method": "session/prompt", "params": {"input": "hello"}})
        )
        await runtime.started.wait()
        handled = await server._handle_control_message(
            {"request_id": 38, "method": "session/replay", "params": {"session_id": "archived"}}
        )
        assert not turn_task.done()
        runtime.release.set()
        await turn_task
        return handled

    handled = asyncio.run(run())
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    replay = next(message for message in messages if message.get("request_id") == 38)

    assert handled is True
    assert replay["result"] == {
        "messages": [{"role": "user", "content": "archived history"}],
        "turn_state": None,
        "session_id": "archived",
        "model": "m1",
    }


def test_session_switch_is_rejected_while_run_turn_is_blocked(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.switched: list[str] = []

        async def run_turn(self, **_kwargs):
            self.started.set()
            await self.release.wait()
            yield type(
                "Event",
                (),
                {
                    "to_dict": lambda _self: {
                        "type": "turn_completed",
                        "ts": "1700000000.0",
                        "session_id": "s1",
                        "turn_id": "t1",
                    }
                },
            )()

        async def switch_session(self, session_id):
            self.switched.append(session_id)
            return {"session_id": session_id}

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        turn_task = asyncio.create_task(
            server._run_turn({"request_id": 39, "method": "session/prompt", "params": {"input": "hello"}})
        )
        await runtime.started.wait()
        handled = await server._handle_control_message(
            {"request_id": 40, "method": "session/switch", "params": {"session_id": "archived"}}
        )
        assert not turn_task.done()
        runtime.release.set()
        await turn_task
        return runtime, handled

    runtime, handled = asyncio.run(run())
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    response = next(message for message in messages if message.get("request_id") == 40)

    assert handled is True
    assert runtime.switched == []
    assert response["error"] == {
        "message": "Cannot switch sessions while a turn is running.",
        "type": "TurnActive",
    }


def test_session_switch_is_rejected_while_turn_start_is_queued(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._ingest_line(
            json.dumps({"kind": "request", "request_id": 41, "method": "session/prompt", "params": {"input": "hello"}})
        )
        handled = await server._handle_control_message(
            {"request_id": 42, "method": "session/switch", "params": {"session_id": "archived"}}
        )
        return server, handled

    server, handled = asyncio.run(run())
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    response = next(message for message in messages if message.get("request_id") == 42)

    assert handled is True
    assert server._queued_turn_starts == 1
    assert response["error"]["type"] == "TurnActive"


def test_slash_usage_errors_return_as_command_results(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._execute_slash(
            {"kind": "request", "request_id": 19, "method": "rind/command/execute", "params": {"input": "/status bad"}}
        )
        await server._execute_slash(
            {"kind": "request", "request_id": 20, "method": "rind/command/execute", "params": {"input": "/doctor extra"}}
        )

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["result"]["text"] == "Usage: /status"
    assert messages[1]["result"]["text"] == "Usage: /doctor"


def test_compact_slash_is_rejected_while_a_turn_is_active(capsys):
    class Runtime(_BlockingTurnRuntime):
        @property
        def turn_active(self) -> bool:
            return self.started.is_set() and not self.release.is_set()

        async def compact_context(self, reason="manual", cancellation_token=None):
            raise AssertionError("compact must not run while a turn is active")

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        turn_task = asyncio.create_task(
            server._run_turn({"kind": "request", "request_id": 47, "method": "session/prompt", "params": {"input": "hello"}})
        )
        await runtime.started.wait()
        await server._execute_slash(
            {"kind": "request", "request_id": 48, "method": "rind/command/execute", "params": {"input": "/compact"}}
        )
        runtime.release.set()
        await turn_task

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    compact = next(message for message in messages if message.get("request_id") == 48)

    assert compact["result"]["text"] == (
        "Cannot compact while a turn is running. Wait for it to finish or interrupt it first."
    )


def test_compact_request_returns_turn_active_error_while_a_turn_is_active(capsys):
    class Runtime(_BlockingTurnRuntime):
        @property
        def turn_active(self) -> bool:
            return self.started.is_set() and not self.release.is_set()

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        turn_task = asyncio.create_task(
            server._run_turn({"kind": "request", "request_id": 49, "method": "session/prompt", "params": {"input": "hello"}})
        )
        await runtime.started.wait()
        await server._compact(
            {"kind": "request", "request_id": 50, "method": "rind/session/compact", "params": {}}
        )
        runtime.release.set()
        await turn_task

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    compact = next(message for message in messages if message.get("request_id") == 50)

    assert compact["error"] == {
        "type": "TurnActive",
        "message": "Cannot compact context while a turn is active.",
    }


def test_shutdown_cancels_inflight_dispatch_and_exits_promptly(capsys):
    async def run():
        runtime = _BlockingTurnRuntime()
        server = StdioRuntimeServer(runtime, _Session())
        serve = asyncio.create_task(server._serve())
        server._requests.put_nowait(
            {"kind": "request", "request_id": 51, "method": "session/prompt", "params": {"input": "hello"}}
        )
        await runtime.started.wait()
        server._begin_shutdown(
            {"kind": "request", "request_id": "bye", "method": "shutdown", "params": {}}
        )
        return await asyncio.wait_for(serve, 10)

    assert asyncio.run(run()) == 0

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert any(
        message.get("request_id") == "bye" and message.get("result") == {"ok": True}
        for message in messages
    )
    assert not any(message.get("request_id") == 51 for message in messages)


def test_models_list_returns_unique_sorted_models_and_current_marker(capsys):
    class Models:
        def list(self):
            return _AsyncModelList([_Model("z-model"), _Model("m1"), _Model("a-model"), _Model("z-model")])

    class Client:
        models = Models()

    async def run():
        server = StdioRuntimeServer(
            _Runtime(),
            _Session(),
            model_client_factory=Client,
            default_model="default-model",
        )
        await server._list_models({"request_id": 9, "method": "model/list", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    result = message["result"]
    assert result["current_model"] == "m1"
    assert result["default_model"] == "default-model"
    assert result["models"] == ["a-model", "m1", "z-model"]


def test_models_list_includes_current_model_when_missing(capsys):
    class Models:
        def list(self):
            return _AsyncModelList([_Model("a-model"), _Model("b-model")])

    class Client:
        models = Models()

    async def run():
        server = StdioRuntimeServer(
            _Runtime(),
            _Session(),
            model_client_factory=Client,
            default_model="default-model",
        )
        await server._list_models({"request_id": 10, "method": "model/list", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"]["models"] == ["m1", "a-model", "b-model"]


def test_models_list_failure_returns_protocol_error(capsys):
    class Models:
        def list(self):
            raise RuntimeError("models endpoint unavailable")

    class Client:
        models = Models()

    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session(), model_client_factory=Client)
        await server._dispatch({"request_id": 11, "method": "model/list", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["error"]["type"] == "RuntimeError"
    assert message["error"]["message"] == "models endpoint unavailable"


def test_model_set_updates_session_without_changing_settings(capsys, tmp_path, monkeypatch):
    path = tmp_path / ".rind" / "settings.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"model": "old-model", "apiKey": "secret-value"}), encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    Config.reload()

    class Session(_Session):
        def __init__(self):
            self.model = "old-model"

        async def update_model(self, model):
            self.model = model

    async def run():
        runtime = _Runtime()
        session = Session()
        server = StdioRuntimeServer(runtime, session, default_model="old-model")
        await server._set_model({"request_id": 12, "method": "model/set", "params": {"model": "new-model"}})
        return runtime, session, server

    runtime, session, server = asyncio.run(run())
    message = json.loads(capsys.readouterr().out)
    data = json.loads(path.read_text(encoding="utf-8"))

    assert message["result"]["runtime"] is True
    assert message["result"]["session"] is True
    assert message["result"]["model"] == "new-model"
    assert message["result"]["session_model"] == "new-model"
    assert message["result"]["default_model"] == "old-model"
    assert message["result"]["default_updated"] is False
    assert runtime.model == "new-model"
    assert session.model == "new-model"
    assert server._default_model == "old-model"
    assert data["model"] == "old-model"
    assert data["apiKey"] == "secret-value"


class _TextStream:
    def __init__(self):
        self.calls = []

    def reconfigure(self, **kwargs):
        self.calls.append(kwargs)


def test_configure_utf8_stdio_pins_protocol_stream_encoding(monkeypatch):
    streams = [_TextStream(), _TextStream(), _TextStream()]
    monkeypatch.setattr(sys, "stdin", streams[0])
    monkeypatch.setattr(sys, "stdout", streams[1])
    monkeypatch.setattr(sys, "stderr", streams[2])

    configure_utf8_stdio()

    assert [stream.calls for stream in streams] == [
        [{"encoding": "utf-8", "errors": "replace"}],
        [{"encoding": "utf-8", "errors": "replace"}],
        [{"encoding": "utf-8", "errors": "replace"}],
    ]


def test_configure_stdio_server_signals_ignores_console_sigint(monkeypatch):
    calls = []

    def fake_signal(signum, handler):
        calls.append((signum, handler))

    monkeypatch.setattr(signal, "signal", fake_signal)

    configure_stdio_server_signals()

    assert calls == [(signal.SIGINT, signal.SIG_IGN)]


def test_app_server_process_serves_git_backed_commands_and_exits_after_shutdown(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (home / ".rind").mkdir(parents=True)
    workspace.mkdir()
    (home / ".rind" / "settings.json").write_text(json.dumps({"apiKey": "test-key"}), encoding="utf-8")

    env = dict(os.environ)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    # Keep the child interpreter's user-site packages visible even though HOME
    # is redirected; otherwise imports installed under the real HOME break.
    env["PYTHONUSERBASE"] = os.environ.get("PYTHONUSERBASE") or str(Path.home() / ".local")
    process = subprocess.Popen(
        [sys.executable, "main.py", "app-server", "--stdio", "--cwd", str(workspace)],
        cwd=PROJECT_ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        assert process.stdin and process.stdout

        def read_response(timeout=5):
            result = []
            reader = threading.Thread(target=lambda: result.append(process.stdout.readline()), daemon=True)
            reader.start()
            reader.join(timeout)
            assert not reader.is_alive(), "Runtime did not return a response in time."
            return json.loads(result[0])

        process.stdin.write(json.dumps({"kind": "request", "request_id": "init", "method": "initialize"}) + "\n")
        process.stdin.flush()
        initialize = read_response()
        assert initialize.get("kind") == "response", initialize
        session_id = initialize["result"]["session_id"]
        assert isinstance(session_id, str) and session_id

        process.stdin.write(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": "status",
                    "method": "rind/command/execute",
                    "params": {"session_id": session_id, "input": "/status"},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        status = read_response()
        assert status.get("request_id") == "status", status
        assert status.get("result", {}).get("display", {}).get("type") == "status", status

        process.stdin.write(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": "doctor",
                    "method": "rind/command/execute",
                    "params": {"session_id": session_id, "input": "/doctor"},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        doctor = read_response()
        assert doctor.get("request_id") == "doctor", doctor
        assert doctor.get("result", {}).get("display", {}).get("type") == "doctor", doctor

        process.stdin.write(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": "missing-session",
                    "method": "session/replay",
                    "params": {},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        missing_session = read_response()
        assert missing_session["error"]["type"] == "InvalidRequest", missing_session

        process.stdin.write(json.dumps({"kind": "request", "request_id": "bye", "method": "shutdown"}) + "\n")
        process.stdin.flush()
        shutdown = read_response()
        assert shutdown.get("result") == {"ok": True}, shutdown

        process.wait(timeout=20)
        assert process.returncode == 0
    finally:
        process.kill()
