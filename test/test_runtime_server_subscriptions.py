"""Multi-session subscription and multi-connection event sink coverage (W1)."""

from __future__ import annotations

import asyncio
import inspect
import os
import sys
from pathlib import Path
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.protocol import RuntimeMethod
from agent.runtime.server.stdio import WorkerStdioRuntimeServer
from agent.runtime.server.worker import ExecutionCoordinator


class _CaptureWriter:
    def __init__(self, name: str):
        self.name = name
        self.payloads: list[dict] = []
        self.closed = False

    async def send(self, payload: dict) -> None:
        self.payloads.append(payload)

    def close(self) -> None:
        self.closed = True


class _Execution:
    """ExecutionCoordinator stand-in exposing the sink registry contract."""

    def __init__(self):
        self._sinks: list = []
        self.prompted: list[str] = []

    def add_event_sink(self, sink):
        self._sinks.append(sink)

        def remove():
            if sink in self._sinks:
                self._sinks.remove(sink)

        return remove

    def set_event_sink(self, sink):
        self._sinks.clear()
        if sink is not None:
            self._sinks.append(sink)

    async def run_turn(self, session_id, *, query, transient_system_messages=None, resume=False, continuation=False):
        self.prompted.append(session_id)
        turn_id = f"turn-{session_id}-{len(self.prompted)}"
        for event_type in ("turn_started", "turn_completed"):
            event = {"type": event_type, "session_id": session_id, "turn_id": turn_id}
            if continuation:
                for sink in list(self._sinks):
                    sink_result = sink(event)
                    if inspect.isawaitable(sink_result):
                        await sink_result
            yield event


class _Worker:
    def __init__(self, known_sessions=("alpha", "beta", "gamma"), initial_session="alpha"):
        self.execution = _Execution()
        self.session_id = initial_session
        self.workspace_root = "."
        self.known_sessions = set(known_sessions)

    async def initialize(self):
        return {"session_id": self.session_id, "model": "test-model", "message_count": 0}

    async def create_session(self, workspace_root=None):
        return {"session_id": "delta", "model": "test-model"}

    async def session(self, session_id):
        if session_id not in self.known_sessions:
            raise LookupError(f"Session not found: {session_id}")
        return {"session_id": session_id, "model": "test-model", "message_count": 0}

    async def close(self):
        return None


def _make_server(worker: _Worker) -> tuple[WorkerStdioRuntimeServer, _CaptureWriter]:
    writer = _CaptureWriter("writer")
    server = WorkerStdioRuntimeServer(worker, writer=writer)
    server._initialized = True
    return server, writer


def _request(request_id: str, method: str, params: dict) -> dict:
    return {"kind": "request", "request_id": request_id, "method": method, "params": params}


def _events(payloads: list[dict], session_id: str | None = None) -> list[dict]:
    return [
        payload
        for payload in payloads
        if payload.get("kind") == "event" and (session_id is None or payload["session_id"] == session_id)
    ]


def _responses(payloads: list[dict]) -> dict[str, dict]:
    return {
        payload["request_id"]: payload
        for payload in payloads
        if payload.get("kind") == "response"
    }


def test_one_connection_subscribed_to_two_sessions_receives_both_event_streams():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        await server.dispatch(
            _request("subscribe-beta", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "beta"})
        )
        await server.dispatch(
            _request("prompt-alpha", RuntimeMethod.SESSION_PROMPT, {"session_id": "alpha", "input": "hi alpha"})
        )
        await server.dispatch(
            _request("prompt-beta", RuntimeMethod.SESSION_PROMPT, {"session_id": "beta", "input": "hi beta"})
        )
        return writer

    writer = asyncio.run(run())

    subscribe = _responses(writer.payloads)["subscribe-beta"]
    assert subscribe["result"] == {"ok": True, "subscribed": ["alpha", "beta"]}
    alpha_events = _events(writer.payloads, "alpha")
    beta_events = _events(writer.payloads, "beta")
    assert [event["event"]["type"] for event in alpha_events] == ["turn_started", "turn_completed"]
    assert [event["event"]["type"] for event in beta_events] == ["turn_started", "turn_completed"]
    assert all(event["session_id"] == "alpha" for event in alpha_events)
    assert all(event["session_id"] == "beta" for event in beta_events)
    assert len(alpha_events[0]["event"]["turn_id"]) > 0
    assert beta_events[0]["event"]["turn_id"] != alpha_events[0]["event"]["turn_id"]


def test_non_subscribed_session_events_are_not_delivered():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        async for _event in worker.execution.run_turn("alpha", query=None, continuation=True):
            pass
        delivered = len(_events(writer.payloads, "alpha"))
        async for _event in worker.execution.run_turn("gamma", query=None, continuation=True):
            pass
        return writer, delivered

    writer, delivered = asyncio.run(run())

    assert delivered == 2
    assert _events(writer.payloads, "gamma") == []


def test_duplicate_subscribe_is_idempotent_sorted_and_deduplicated():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        await server.dispatch(_request("sub-gamma", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "gamma"}))
        first = await server.dispatch(
            _request("sub-beta-1", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "beta"})
        )
        second = await server.dispatch(
            _request("sub-beta-2", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "beta"})
        )
        return server, writer

    server, writer = asyncio.run(run())

    responses = _responses(writer.payloads)
    first = responses["sub-beta-1"]
    second = responses["sub-beta-2"]
    assert first["result"] == {"ok": True, "subscribed": ["alpha", "beta", "gamma"]}
    assert second["result"] == first["result"]
    assert server._subscribed == {"alpha", "beta", "gamma"}


def test_subscribe_unknown_session_returns_session_not_found_and_keeps_set():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        await server.dispatch(_request("sub-missing", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "missing"}))
        return server, writer

    server, writer = asyncio.run(run())

    error = next(payload for payload in writer.payloads if payload.get("request_id") == "sub-missing")
    assert error["error"]["type"] == "SessionNotFound"
    assert server._subscribed == {"alpha"}


def test_unsubscribe_current_session_then_prompt_implicitly_resubscribes():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        await server.dispatch(_request("unsub", RuntimeMethod.SESSION_UNSUBSCRIBE, {"session_id": "alpha"}))
        async for _event in worker.execution.run_turn("alpha", query=None, continuation=True):
            pass
        dropped = len(_events(writer.payloads, "alpha"))
        await server.dispatch(
            _request("prompt-alpha", RuntimeMethod.SESSION_PROMPT, {"session_id": "alpha", "input": "back"})
        )
        async for _event in worker.execution.run_turn("alpha", query=None, continuation=True):
            pass
        return server, writer, dropped

    server, writer, dropped = asyncio.run(run())

    assert dropped == 0
    assert server._subscribed == {"alpha"}
    assert len(_events(writer.payloads, "alpha")) == 4


def test_after_switch_old_session_events_require_explicit_subscription():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        await server.dispatch(_request("sub-gamma", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "gamma"}))
        await server.dispatch(_request("switch", RuntimeMethod.SESSION_SWITCH, {"session_id": "beta"}))
        switched_set = sorted(server._subscribed)
        await server.dispatch(_request("unsub-alpha", RuntimeMethod.SESSION_UNSUBSCRIBE, {"session_id": "alpha"}))
        async for _event in worker.execution.run_turn("alpha", query=None, continuation=True):
            pass
        old_delivered = len(_events(writer.payloads, "alpha"))
        async for _event in worker.execution.run_turn("beta", query=None, continuation=True):
            pass
        current_delivered = len(_events(writer.payloads, "beta"))
        await server.dispatch(_request("sub-alpha", RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": "alpha"}))
        async for _event in worker.execution.run_turn("alpha", query=None, continuation=True):
            pass
        resubscribed_delivered = len(_events(writer.payloads, "alpha"))
        return writer, switched_set, old_delivered, current_delivered, resubscribed_delivered

    writer, switched_set, old_delivered, current_delivered, resubscribed_delivered = asyncio.run(run())

    assert switched_set == ["alpha", "beta", "gamma"]
    assert old_delivered == 0
    assert current_delivered == 2
    assert resubscribed_delivered == 2
    assert len(_events(writer.payloads, "beta")) == 2


def test_unsubscribe_is_idempotent_for_non_subscribed_session():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        await server.dispatch(_request("unsub-gamma", RuntimeMethod.SESSION_UNSUBSCRIBE, {"session_id": "gamma"}))
        await server.dispatch(_request("unsub-gamma-2", RuntimeMethod.SESSION_UNSUBSCRIBE, {"session_id": "gamma"}))
        return writer

    writer = asyncio.run(run())

    unsubscribe_results = [
        payload["result"]
        for payload in writer.payloads
        if payload.get("request_id") in {"unsub-gamma", "unsub-gamma-2"}
    ]
    assert unsubscribe_results == [
        {"ok": True, "subscribed": ["alpha"]},
        {"ok": True, "subscribed": ["alpha"]},
    ]


def test_close_unregisters_sink_and_closes_writer():
    async def run():
        worker = _Worker()
        server, writer = _make_server(worker)
        await server.dispatch(_request("init", RuntimeMethod.INITIALIZE, {}))
        server.close()
        assert writer.closed
        async for _event in worker.execution.run_turn("alpha", query=None, continuation=True):
            pass
        return writer

    writer = asyncio.run(run())

    assert writer.closed
    assert _events(writer.payloads) == []


# --- two dispatchers over one real coordinator -------------------------------


class _Event:
    def __init__(self, event_type: str, session_id: str, turn_id: str):
        self._data = {"type": event_type, "session_id": session_id, "turn_id": turn_id}

    def to_dict(self):
        return dict(self._data)


class _SharedRuntime:
    turn_active = False

    def set_user_question_responder(self, _responder):
        return None

    async def run_turn(self, **_kwargs):
        yield _Event("turn_started", "alpha", "turn-shared")
        yield _Event("turn_completed", "alpha", "turn-shared")


class _SharedExecution(ExecutionCoordinator):
    async def start(self, session_id):
        execution = self._active.get(session_id)
        if execution is None:
            execution = SimpleNamespace(
                container=SimpleNamespace(runtime=_SharedRuntime()),
                turn_slot=asyncio.Lock(),
                current_cancel=None,
                pending_answers={},
                queued_turn_starts=0,
            )
            self._active[session_id] = execution
        return execution.container


class _SharedWorker:
    session_id = "alpha"
    workspace_root = "."

    def __init__(self, execution):
        self.execution = execution

    async def initialize(self):
        return {"session_id": "alpha", "model": "test-model", "message_count": 0}

    async def close(self):
        return None


def test_two_dispatchers_on_one_coordinator_both_receive_continuation_events():
    async def run():
        execution = _SharedExecution(
            shared_resources=SimpleNamespace(),
            repository=SimpleNamespace(),
            debug=False,
            enable_goal=False,
            enable_user_question=False,
            session_dir=None,
        )
        worker = _SharedWorker(execution)
        writer_a = _CaptureWriter("a")
        writer_b = _CaptureWriter("b")
        server_a = WorkerStdioRuntimeServer(worker, writer=writer_a)
        server_b = WorkerStdioRuntimeServer(worker, writer=writer_b)
        await server_a.dispatch(_request("init-a", RuntimeMethod.INITIALIZE, {}))
        await server_b.dispatch(_request("init-b", RuntimeMethod.INITIALIZE, {}))
        async for _event in execution.run_turn("alpha", query=None, continuation=True):
            pass
        return writer_a, writer_b

    writer_a, writer_b = asyncio.run(run())

    assert [event["event"]["type"] for event in _events(writer_a.payloads)] == ["turn_started", "turn_completed"]
    assert [event["event"]["type"] for event in _events(writer_b.payloads)] == ["turn_started", "turn_completed"]
    assert [event["sequence"] for event in _events(writer_a.payloads)] == [1, 2]
    assert [event["sequence"] for event in _events(writer_b.payloads)] == [1, 2]
