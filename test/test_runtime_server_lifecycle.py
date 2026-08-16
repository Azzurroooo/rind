import asyncio
import io
import json
import sys
import threading
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.runtime.server.app_server import async_main
from agent.runtime.server.stdio import StdioRuntimeServer


class _Session:
    session_id = "session-1"
    model = "model-1"


class _Runtime:
    def set_user_question_responder(self, responder):
        self.responder = responder

    def discard_pending_inputs(self):
        return None


class _Event:
    def __init__(self, event_type: str):
        self._event_type = event_type

    def to_dict(self):
        return {
            "type": self._event_type,
            "ts": "2026-08-10T00:00:00Z",
            "session_id": "session-1",
            "turn_id": "turn-1",
        }


class _BlockingRuntime(_Runtime):
    def __init__(self):
        self.started = asyncio.Event()

    async def run_turn(self, *, cancellation_token, **_kwargs):
        self.started.set()
        await cancellation_token.wait()
        yield _Event("turn_cancelled")


class _BlockingInput:
    def __init__(self, line: str):
        self._line = line
        self._closed = threading.Event()

    def readline(self):
        if self._line:
            line = self._line
            self._line = ""
            return line
        self._closed.wait()
        return ""

    def close(self):
        self._closed.set()


def _messages(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_invalid_json_and_invalid_request_return_structured_errors(monkeypatch, capsys):
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            'not-json\n'
            '{"kind":"request","request_id":"bad-params","method":"initialize","params":[]}\n'
            '{"request_id":"missing-kind","method":"initialize","params":{}}\n'
        ),
    )

    assert asyncio.run(StdioRuntimeServer(_Runtime(), _Session()).run()) == 0

    messages = _messages(capsys)
    assert messages == [
        {
            "kind": "response",
            "request_id": None,
            "error": {"type": "ParseError", "message": "Invalid JSON request."},
        },
        {
            "kind": "response",
            "request_id": "bad-params",
            "error": {"type": "InvalidRequest", "message": "params must be an object."},
        },
        {
            "kind": "response",
            "request_id": "missing-kind",
            "error": {"type": "InvalidRequest", "message": 'kind must be "request".'},
        },
    ]


def test_eof_cancels_an_active_turn_and_exits(monkeypatch, capsys):
    async def run():
        runtime = _BlockingRuntime()
        standard_input = _BlockingInput(
            '{"kind":"request","request_id":"turn-1","method":"session/prompt","params":{"input":"hello"}}\n'
        )
        monkeypatch.setattr(sys, "stdin", standard_input)
        server_task = asyncio.create_task(StdioRuntimeServer(runtime, _Session()).run())
        await runtime.started.wait()
        standard_input.close()
        return await asyncio.wait_for(server_task, timeout=1)

    assert asyncio.run(run()) == 0

    messages = _messages(capsys)
    assert messages[0]["method"] == "session/update"
    assert messages[1]["request_id"] == "turn-1"
    assert messages[1]["result"]["ok"] is True


def test_shutdown_and_repeated_shutdown_each_receive_one_response(capsys):
    async def run():
        runtime = _BlockingRuntime()
        server = StdioRuntimeServer(runtime, _Session())
        serve_task = asyncio.create_task(server._serve())
        await server._requests.put(
            {"request_id": "turn-1", "method": "session/prompt", "params": {"input": "hello"}}
        )
        await runtime.started.wait()
        assert await server._handle_control_message(
            {"request_id": "shutdown-1", "method": "shutdown", "params": {}}
        )
        assert await server._handle_control_message(
            {"request_id": "shutdown-2", "method": "shutdown", "params": {}}
        )
        return await asyncio.wait_for(serve_task, timeout=1)

    assert asyncio.run(run()) == 0

    messages = _messages(capsys)
    responses = {message["request_id"]: message for message in messages if message["kind"] == "response"}
    assert responses["turn-1"]["result"]["ok"] is True
    assert responses["shutdown-1"]["result"] == {"ok": True}
    assert responses["shutdown-2"]["error"]["type"] == "ServerStopping"
    assert len(responses) == 3


def test_repeated_interrupt_returns_recoverable_error(capsys):
    async def run():
        server = StdioRuntimeServer(_Runtime(), _Session())
        cancel_source = CancellationTokenSource()
        server._current_cancel = cancel_source
        try:
            await server._handle_control_message(
                {"request_id": "interrupt-1", "method": "session/cancel", "params": {}}
            )
            await server._handle_control_message(
                {"request_id": "interrupt-2", "method": "session/cancel", "params": {}}
            )
        finally:
            cancel_source.dispose()

    asyncio.run(run())

    messages = _messages(capsys)
    assert messages[0]["result"] == {"ok": True}
    assert messages[1]["error"] == {
        "type": "TurnNotActive",
        "message": "No active turn to interrupt.",
    }


def test_app_server_rejects_a_missing_workspace(capsys, tmp_path):
    exit_code = asyncio.run(
        async_main(["--stdio", "--cwd", str(tmp_path / "missing")], server_class=StdioRuntimeServer)
    )

    assert exit_code == 1
    assert "Workspace directory does not exist" in capsys.readouterr().err
