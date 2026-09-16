import asyncio
import io
import json
import sys
import threading
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.app_server import async_main
from agent.runtime.server.stdio import WorkerStdioRuntimeServer


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


class _Execution:
    def __init__(self):
        self.started = asyncio.Event()
        self.cancel = asyncio.Event()
        self.interrupted = False

    def active_session_ids(self):
        return set() if self.interrupted and self.cancel.is_set() and not self.started.is_set() else {"session-1"}

    def active_turn_id(self, _session_id):
        return "turn-1" if not self.interrupted else ""

    def add_event_sink(self, sink):
        self.sink = sink
        return lambda: None

    def interrupt(self, _session_id, _reason="interrupted"):
        if self.interrupted:
            return False
        self.interrupted = True
        self.cancel.set()
        return True

    async def run_turn(self, _session_id, *, cancellation_token=None, **_kwargs):
        self.started.set()
        await (cancellation_token.wait() if cancellation_token is not None else self.cancel.wait())
        yield {"type": "turn_cancelled", "session_id": "session-1", "turn_id": "turn-1"}


class _Worker:
    worker_mode = True
    session_id = "session-1"
    workspace_root = "."

    def __init__(self):
        self.execution = _Execution()

    def list_providers(self):
        return []

    async def initialize(self):
        return {"session_id": self.session_id, "workspace_root": self.workspace_root, "message_count": 0}

    async def session(self, session_id):
        return {"session_id": session_id, "provider": "", "model": "", "workspace_root": self.workspace_root}

    async def close(self):
        return None


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

    assert asyncio.run(WorkerStdioRuntimeServer(_Worker()).run()) == 0

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
        worker = _Worker()
        standard_input = _BlockingInput(
            '{"kind":"request","request_id":"turn-1","method":"session/prompt","params":{"session_id":"session-1","input":"hello"}}\n'
        )
        monkeypatch.setattr(sys, "stdin", standard_input)
        server = WorkerStdioRuntimeServer(worker)
        server._initialized = True
        server_task = asyncio.create_task(server.run())
        await worker.execution.started.wait()
        standard_input.close()
        return await asyncio.wait_for(server_task, timeout=5)

    assert asyncio.run(run()) == 0

    messages = _messages(capsys)
    assert messages[0]["method"] == "session/update"
    responses = [message for message in messages if message.get("kind") == "response"]
    assert responses[-1]["request_id"] == "turn-1"
    assert responses[-1]["result"]["ok"] is True


def test_shutdown_and_repeated_shutdown_each_receive_one_response(capsys):
    async def run():
        worker = _Worker()
        server = WorkerStdioRuntimeServer(worker)
        serve_task = asyncio.create_task(server._serve())
        server._initialized = True
        await server._requests.put(
            {"request_id": "turn-1", "method": "session/prompt", "params": {"session_id": "session-1", "input": "hello"}}
        )
        await worker.execution.started.wait()
        first = server._begin_shutdown({"request_id": "shutdown-1", "method": "shutdown", "params": {}})
        second = server._begin_shutdown({"request_id": "shutdown-2", "method": "shutdown", "params": {}})
        assert first is True
        assert second is False
        return await asyncio.wait_for(serve_task, timeout=5)

    assert asyncio.run(run()) == 0

    messages = _messages(capsys)
    responses = {message["request_id"]: message for message in messages if message["kind"] == "response"}
    assert responses["turn-1"]["result"]["ok"] is True
    assert responses["shutdown-1"]["result"] == {"ok": True}
    assert len(responses) == 2


def test_repeated_interrupt_returns_recoverable_error(capsys):
    async def run():
        worker = _Worker()
        server = WorkerStdioRuntimeServer(worker)
        server._initialized = True
        await server._dispatch({"request_id": "interrupt-1", "method": "session/cancel", "params": {"session_id": "session-1"}})
        await server._dispatch({"request_id": "interrupt-2", "method": "session/cancel", "params": {"session_id": "session-1"}})

    asyncio.run(run())

    messages = _messages(capsys)
    assert messages[0]["result"] == {"ok": True}
    assert messages[1]["error"] == {
        "type": "TurnNotActive",
        "message": "The requested turn is no longer active.",
    }


def test_app_server_rejects_a_missing_workspace(capsys, tmp_path):
    exit_code = asyncio.run(
        async_main(["--stdio", "--cwd", str(tmp_path / "missing")], server_class=WorkerStdioRuntimeServer)
    )

    assert exit_code == 1
    assert "Workspace directory does not exist" in capsys.readouterr().err
