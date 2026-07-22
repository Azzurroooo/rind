import asyncio
import json
import os
import signal
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.interfaces.runtime_server.stdio import (
    JsonlWriter,
    StdioRuntimeServer,
    configure_stdio_server_signals,
    configure_utf8_stdio,
)
from agent.interfaces.runtime_server.protocol import event_envelope
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


def test_question_response_completes_pending_future():
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        event = type("Event", (), {"tool_call_id": "call-1"})()
        task = asyncio.create_task(server._answer_user_question(event))
        await asyncio.sleep(0)
        await server._receive_user_answer(
            {"request_id": 1, "method": "user_question.respond", "params": {"tool_call_id": "call-1", "answer": "yes"}}
        )
        return await task

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
    assert messages[0]["event_type"] == "assistant_delta"
    assert messages[0]["durability"] == "incremental"
    assert messages[0]["timestamp"] == "1700000000.0"
    assert messages[0]["session_id"] == "s1"
    assert messages[0]["turn_id"] == "t1"
    assert messages[0]["event"]["text"] == "hello"


def test_golden_event_fixture_matches_python_envelope():
    fixture = PROJECT_ROOT / "test" / "fixtures" / "runtime_protocol.golden.jsonl"
    messages = [json.loads(line) for line in fixture.read_text(encoding="utf-8").splitlines()]

    assert [event_envelope(message["event"], message["sequence"]) for message in messages] == messages


def test_event_envelope_separates_durable_and_incremental_events():
    assert event_envelope({"type": "assistant_delta"}, 1)["durability"] == "incremental"
    assert event_envelope({"type": "tool_result"}, 2)["durability"] == "durable"


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
        await server._run_turn({"request_id": 21, "method": "turn.start", "params": {"input": "hello"}})

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["event_type"] == "turn_started"
    assert messages[1]["request_id"] == 21
    assert messages[1]["result"] == {"ok": True, "session_id": "s1", "turn_id": "t1"}


def test_initialize_response_includes_resume_preview_when_history_exists(capsys):
    class Session:
        session_id = "s1"
        model = "m1"

        async def get_messages_slice(self):
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
    assert result["protocol_version"] == "1"
    assert result["capabilities"] == [
        "events",
        "turns",
        "slash_commands",
        "models",
        "compaction",
        "user_questions",
        "durable_replay",
    ]
    assert result["session_id"] == "s1"
    assert result["model"] == "m1"
    assert "Resumed session s1" in result["resume_preview"]
    assert "- user: hello" in result["resume_preview"]
    assert any(command["name"] == "status" for command in result["slash_commands"])


def test_session_replay_returns_projected_messages_and_turn_state(capsys):
    class Session(_Session):
        async def get_messages_slice(self, start=None, end=None):
            return [{"role": "user", "content": "hello"}][slice(start, end)]

        async def get_turn_state(self):
            return {"turn_id": "t1", "status": "completed", "ts": "now"}

    async def run():
        server = StdioRuntimeServer(_Runtime(), Session())
        await server._replay({"request_id": 23, "method": "session.replay", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"] == {
        "messages": [{"role": "user", "content": "hello"}],
        "turn_state": {"turn_id": "t1", "status": "completed", "ts": "now"},
    }


def test_slash_execute_reuses_cli_router(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._execute_slash({"request_id": 8, "method": "slash.execute", "params": {"input": "/compact"}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    result = message["result"]
    assert result["should_exit"] is False
    assert result["clear_screen"] is False
    assert result["context_usage_reset"] is True
    assert result["display"] is None
    assert result["text"].startswith("Compact complete.")


def test_slash_execute_non_compact_does_not_reset_context_usage(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        await server._execute_slash({"request_id": 14, "method": "slash.execute", "params": {"input": "/help"}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["result"]["context_usage_reset"] is False
    assert message["result"]["display"]["type"] == "help"


def test_readonly_status_slash_responds_without_main_queue(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session(), debug=True)
        server._initialized = True
        handled = await server._handle_control_message(
            {"request_id": 15, "method": "slash.execute", "params": {"input": "/status"}}
        )
        await asyncio.sleep(0)
        queued = server._requests.empty()
        return handled, queued

    handled, queued = asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert handled is True
    assert queued is True
    assert message["result"]["text"].startswith("```text\nStatus:")
    assert "Session: s1" in message["result"]["text"]
    assert message["result"]["display"]["type"] == "status"
    assert message["result"]["display"]["session"] == "s1"


def test_readonly_doctor_slash_responds_without_main_queue(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._initialized = True
        handled = await server._handle_control_message(
            {"request_id": 16, "method": "slash.execute", "params": {"input": "/doctor"}}
        )
        await asyncio.sleep(0)
        return handled, server._requests.empty()

    handled, queued = asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert handled is True
    assert queued is True
    assert message["result"]["text"].startswith("Doctor:")
    assert message["result"]["display"]["type"] == "doctor"


def test_readonly_slash_does_not_replace_current_cancel(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._initialized = True
        current = CancellationTokenSource()
        server._current_cancel = current
        handled = await server._handle_control_message(
            {"request_id": 17, "method": "slash.execute", "params": {"input": "/status"}}
        )
        await asyncio.sleep(0)
        same_source = server._current_cancel is current
        current.dispose()
        return handled, same_source

    handled, same_source = asyncio.run(run())

    assert handled is True
    assert same_source is True
    assert json.loads(capsys.readouterr().out)["result"]["text"].startswith("```text\nStatus:")


def test_non_readonly_slash_stays_on_main_queue(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._initialized = True
        message = {"request_id": 18, "method": "slash.execute", "params": {"input": "/help"}}
        handled = await server._handle_control_message(message)
        if not handled:
            await server._requests.put(message)
        queued = await server._requests.get()
        return handled, queued

    handled, queued = asyncio.run(run())

    assert handled is False
    assert queued["params"]["input"] == "/help"
    assert capsys.readouterr().out == ""


def test_readonly_slash_usage_errors_return_immediately(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        server._initialized = True
        await server._handle_control_message(
            {"request_id": 19, "method": "slash.execute", "params": {"input": "/status bad"}}
        )
        await server._handle_control_message(
            {"request_id": 20, "method": "slash.execute", "params": {"input": "/doctor extra"}}
        )
        await asyncio.sleep(0)

    asyncio.run(run())

    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["result"]["text"] == "Usage: /status"
    assert messages[1]["result"]["text"] == "Usage: /doctor"


def test_slash_execute_exposes_cancellation_token_to_interrupt(capsys):
    class Runtime(_Runtime):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.received_token = None

        async def compact_context(self, reason="manual", cancellation_token=None):
            self.received_token = cancellation_token
            self.started.set()
            await cancellation_token.wait()
            raise asyncio.CancelledError(cancellation_token.reason)

    async def run():
        runtime = Runtime()
        server = StdioRuntimeServer(runtime, _Session())
        task = asyncio.create_task(
            server._execute_slash({"request_id": 13, "method": "slash.execute", "params": {"input": "/compact"}})
        )
        await runtime.started.wait()
        server._interrupt_current()
        await task
        return runtime

    runtime = asyncio.run(run())

    assert runtime.received_token is not None
    assert runtime.received_token.is_cancelled is True
    message = json.loads(capsys.readouterr().out)
    assert message["result"]["text"] == "Compact cancelled."
    assert message["result"]["context_usage_reset"] is False
    assert message["result"]["display"] is None


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
        await server._list_models({"request_id": 9, "method": "models.list", "params": {}})

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
        await server._list_models({"request_id": 10, "method": "models.list", "params": {}})

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
        await server._dispatch({"request_id": 11, "method": "models.list", "params": {}})

    asyncio.run(run())

    message = json.loads(capsys.readouterr().out)
    assert message["error"]["type"] == "RuntimeError"
    assert message["error"]["message"] == "models endpoint unavailable"


def test_model_set_updates_settings_runtime_and_session(capsys, tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model": "old-model", "apiKey": "secret-value"}), encoding="utf-8")
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))
    Config.reload()

    class Session(_Session):
        def __init__(self):
            self.model = "old-model"

        async def update_model(self, model):
            self.model = model

    async def run():
        runtime = _Runtime()
        session = Session()
        server = StdioRuntimeServer(runtime, session)
        await server._set_model({"request_id": 12, "method": "model.set", "params": {"model": "new-model"}})
        return runtime, session, server

    runtime, session, server = asyncio.run(run())
    message = json.loads(capsys.readouterr().out)
    data = json.loads(path.read_text(encoding="utf-8"))

    assert message["result"]["runtime"] is True
    assert message["result"]["session"] is True
    assert message["result"]["model"] == "new-model"
    assert runtime.model == "new-model"
    assert session.model == "new-model"
    assert server._default_model == "new-model"
    assert data["model"] == "new-model"
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
