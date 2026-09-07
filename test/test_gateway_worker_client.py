"""WorkerClient tests against a real WebSocket server on 127.0.0.1:0.

The WS server wraps :class:`gateway.fake_worker.FakeWorker` (same JSONL
surface as the app-server), so start/capability gating, request correlation,
live-event dedup, the fixed reconnect catch-up order, WorkerTimeout and stdio
transport parity are all exercised over a genuine socket.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest
from websockets.asyncio.server import serve

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway.fake_worker import WORKER_CAPABILITY, FakeWorker
from gateway.transports import PROJECT_ROOT as GATEWAY_PROJECT_ROOT, _StdioTransport, build_transport
from gateway.worker_client import (
    WORKER_CAPABILITY as CLIENT_CAPABILITY,
    WorkerClient,
    WorkerConnectionError,
    WorkerRequestError,
    WorkerTimeout,
)


async def _until(predicate, timeout=5.0, message="condition not met"):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(message)
        await asyncio.sleep(0.01)


class _Recorder:
    """Event sink mirroring the pump's cursor bookkeeping (durable +1)."""

    def __init__(self):
        self.events = []

    async def __call__(self, envelope, replayed):
        self.events.append((envelope, replayed))


class _RecordingWorker(FakeWorker):
    """FakeWorker that records the JSONL methods it served."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.methods = []
        self.replay_params = []

    async def _handle(self, connection, method, params):
        self.methods.append(method)
        if method == "session/replay":
            self.replay_params.append(dict(params))
        return await super()._handle(connection, method, params)


class _WsServer:
    """Serves one FakeWorker over a real WebSocket on an ephemeral port."""

    def __init__(self, worker):
        self.worker = worker
        self.server = None
        self.port = None

    async def start(self):
        self.server = await serve(self._handler, "127.0.0.1", self.port or 0, max_size=8 * 1024 * 1024)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

    @property
    def url(self):
        return f"ws://127.0.0.1:{self.port}"

    async def _handler(self, websocket):
        connection = self.worker.open_connection()

        async def pump_outbound():
            while True:  # FakeWorker queues frames; forward them to the socket
                payload = await connection.recv()
                await websocket.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

        async def pump_inbound():
            async for raw in websocket:
                request = json.loads(raw)
                if request.get("method") == "drop_connection":  # test hook: server-side drop
                    await websocket.close(code=1000)
                    return
                asyncio.get_running_loop().create_task(self.worker.dispatch(connection, request))

        reader = asyncio.create_task(pump_inbound())
        writer = asyncio.create_task(pump_outbound())
        try:
            await reader
        except Exception:  # noqa: BLE001 - client vanished mid-frame; nothing left to serve
            pass
        finally:
            writer.cancel()


def _client(url, worker, cursor):
    return WorkerClient(url, None, cursor_provider=lambda session_id: cursor.get(session_id, 0))


# --- start / initialize / capability gate ---------------------------------------

def test_start_initializes_and_reports_connected():
    async def scenario():
        worker = _RecordingWorker()
        server = await _WsServer(worker).start()
        client = _client(server.url, worker, {})
        try:
            assert client.connected is False
            await client.start()
            assert client.connected is True
            assert worker.methods[0] == "initialize"
            assert CLIENT_CAPABILITY == WORKER_CAPABILITY
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


def _free_port() -> int:
    """A loopback port that is (momentarily) closed: connections refuse fast."""
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_start_without_capability_fails_with_upgrade_hint():
    async def scenario():
        worker = FakeWorker(capabilities=["sessions", "models"])  # no rind/session-subscriptions
        server = await _WsServer(worker).start()
        client = _client(server.url, worker, {})
        try:
            with pytest.raises(RuntimeError, match="rind/session-subscriptions"):
                await client.start()
            assert client.connected is False
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_connect_retries_until_worker_appears():
    async def scenario():
        worker = FakeWorker()
        port = _free_port()
        server = _WsServer(worker)
        server.port = port
        client = _client(f"ws://127.0.0.1:{port}", worker, {})  # nothing there yet
        start_task = asyncio.create_task(client.start())
        await asyncio.sleep(0.6)  # the first refused attempts back off and retry
        assert start_task.done() is False  # still retrying, not crashed
        await server.start()
        await asyncio.wait_for(start_task, 15)  # exponential backoff lands on the worker
        await client.stop()
        await server.stop()

    asyncio.run(scenario())


# --- request round-trips ----------------------------------------------------------

def test_request_round_trip_correlates_results():
    async def scenario():
        worker = FakeWorker()
        server = await _WsServer(worker).start()
        client = _client(server.url, worker, {})
        try:
            await client.start()
            result = await asyncio.wait_for(client.request("session/new", {"workspace_root": "/ws"}), 5)
            session_id = result["session_id"]
            assert session_id in worker.sessions
            assert worker.created == [{"workspace_root": "/ws"}]
            info = await asyncio.wait_for(client.request("session/replay", {"session_id": session_id}), 5)
            assert info == {"events": [], "cursor": 0}
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


def test_worker_error_envelope_surfaces_as_worker_request_error():
    async def scenario():
        worker = FakeWorker()
        server = await _WsServer(worker).start()
        client = _client(server.url, worker, {})
        try:
            await client.start()
            with pytest.raises(WorkerRequestError, match="session/replay"):
                await asyncio.wait_for(client.request("session/replay", {"session_id": "missing"}), 5)
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


def test_stalled_method_times_out_as_worker_timeout():
    async def scenario():
        worker = FakeWorker(stall_methods=("session/replay",))
        server = await _WsServer(worker).start()
        client = _client(server.url, worker, {})
        try:
            await client.start()
            session_id = (await client.request("session/new", {}))["session_id"]
            with pytest.raises(WorkerTimeout):
                await client.request("session/replay", {"session_id": session_id}, timeout=0.2)
            assert client.connected is True  # timeout does not kill the connection
            ok = await asyncio.wait_for(client.request("session/unsubscribe", {"session_id": session_id}), 5)
            assert ok["ok"] is True  # later requests still work
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


def test_request_without_connection_fails_fast():
    async def scenario():
        worker = FakeWorker()
        client = _client("ws://127.0.0.1:1", worker, {})
        with pytest.raises(WorkerConnectionError):
            await client.request("initialize", {})
        await client.stop()  # idempotent-ish: no tasks started, nothing to hang on

    asyncio.run(scenario())


# --- live events: delivery + dedup -------------------------------------------------

def test_live_events_delivered_and_deduped_by_session_and_sequence():
    async def scenario():
        worker = FakeWorker()
        server = await _WsServer(worker).start()
        client = _client(server.url, worker, {})
        recorder = _Recorder()
        client.on_event(recorder)
        try:
            await client.start()
            session_id = (await client.request("session/new", {}))["session_id"]
            await client.subscribe(session_id)
            worker.push_event(session_id, {"type": "turn_started"})
            await _until(lambda: len(recorder.events) == 1)
            envelope, replayed = recorder.events[0]
            assert replayed is False
            assert envelope["session_id"] == session_id and envelope["event"]["type"] == "turn_started"

            connection = worker._connections[-1]
            connection.send(dict(envelope))  # duplicate frame: same (session_id, sequence)
            await asyncio.sleep(0.1)
            assert len(recorder.events) == 1  # dropped

            worker.push_event(session_id, {"type": "assistant_message_completed", "content": "next"})
            await _until(lambda: len(recorder.events) == 2)  # fresh sequence passes
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


# --- reconnect: fixed catch-up order ------------------------------------------------

def test_reconnect_resubscribes_replays_then_resumes_live():
    async def scenario():
        worker = _RecordingWorker()
        server = await _WsServer(worker).start()
        cursor = {}
        client = _client(server.url, worker, cursor)
        recorder = _Recorder()
        client.on_event(recorder)
        try:
            await client.start()
            session_id = (await client.request("session/new", {}))["session_id"]
            await client.subscribe(session_id)

            worker.push_event(session_id, {"type": "turn_started"})  # durable event #1, live
            await _until(lambda: len(recorder.events) == 1)
            cursor[session_id] = 1  # the pump would have persisted this cursor

            with pytest.raises(WorkerConnectionError):
                await asyncio.wait_for(client.request("drop_connection", {}), 5)
            await _until(lambda: client.connected is False)

            worker.push_event(session_id, {"type": "assistant_message_completed", "content": "missed 1"})
            worker.push_event(session_id, {"type": "turn_completed"})  # durable #2 and #3, while down
            assert len(worker.sessions[session_id].events) == 3

            await _until(lambda: sum(1 for _, replayed in recorder.events if replayed) == 2, timeout=10)
            replayed_types = [envelope["event"]["type"] for envelope, replayed in recorder.events if replayed]
            assert replayed_types == ["assistant_message_completed", "turn_completed"]

            # fixed order after the reconnect's initialize: subscribe → replay(after_cursor)
            reconnect_at = worker.methods.index("initialize", 1)
            assert worker.methods[reconnect_at:] == ["initialize", "session/subscribe", "session/replay"]
            assert worker.replay_params[-1] == {"session_id": session_id, "after_cursor": 1}

            worker.push_event(session_id, {"type": "turn_started"})  # live resumes post-reconnect
            await _until(lambda: len(recorder.events) == 4)
            kinds = [(envelope["event"]["type"], replayed) for envelope, replayed in recorder.events]
            assert kinds == [("turn_started", False), ("assistant_message_completed", True),
                             ("turn_completed", True), ("turn_started", False)]
            # replay envelopes carry their durable ordinal as sequence (events #2 and #3)
            replayed_envelopes = [envelope for envelope, replayed in recorder.events if replayed]
            assert [envelope["sequence"] for envelope in replayed_envelopes] == [2, 3]
            assert recorder.events[3][0]["sequence"] == 1  # new connection epoch restarts sequences
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


def test_reconnect_replays_from_local_cursor_only():
    async def scenario():
        worker = _RecordingWorker()
        server = await _WsServer(worker).start()
        cursor = {}
        client = _client(server.url, worker, cursor)
        recorder = _Recorder()
        client.on_event(recorder)
        try:
            await client.start()
            session_id = (await client.request("session/new", {}))["session_id"]
            await client.subscribe(session_id)
            for index in range(3):
                worker.push_event(session_id, {"type": "assistant_message_completed", "content": f"m{index}"})
                cursor[session_id] = index + 1
            await _until(lambda: len(recorder.events) == 3)

            with pytest.raises(WorkerConnectionError):
                await asyncio.wait_for(client.request("drop_connection", {}), 5)
            await _until(lambda: client.connected is False)
            await _until(lambda: worker.methods.count("session/replay") == 1, timeout=10)
            assert worker.replay_params[-1]["after_cursor"] == 3  # nothing new → empty replay
            fresh = (await client.request("session/replay", {"session_id": session_id, "after_cursor": 3}))
            assert fresh["events"] == [] and fresh["cursor"] == 3
            assert len(recorder.events) == 3  # no duplicates fed to the consumer
        finally:
            await client.stop()
            await server.stop()

    asyncio.run(scenario())


# --- stdio transport parity ----------------------------------------------------------

def test_build_transport_selects_stdio_and_ws():
    stdio = build_transport("stdio", None)
    assert isinstance(stdio, _StdioTransport)
    assert stdio._command == [sys.executable, str(GATEWAY_PROJECT_ROOT / "main.py"), "app-server", "--stdio"]

    ws = build_transport("ws://127.0.0.1:8765", "sekrit")
    assert "token=sekrit" in ws._url
    plain = build_transport("ws://127.0.0.1:8765?token=x", None)
    assert "token=" not in plain._url or plain._url.endswith("token=x")


def test_stdio_transport_matches_ws_semantics_over_fake_worker():
    async def scenario():
        # Spawns the same JSONL surface (`python -m gateway.fake_worker` serves
        # serve_stdio) instead of the full app-server: handshake, request/
        # response, subscribe and replay must behave exactly like WebSocket.
        transport = _StdioTransport([sys.executable, "-m", "gateway.fake_worker"])
        client = WorkerClient("stdio", None, transport=transport)
        try:
            await client.start()  # initialize over stdin/stdout; capability check passes
            assert client.connected is True
            result = await asyncio.wait_for(client.request("session/new", {"workspace_root": "/ws"}), 10)
            session_id = result["session_id"]
            subscribed = await asyncio.wait_for(client.request("session/subscribe", {"session_id": session_id}), 10)
            assert subscribed == {"ok": True, "subscribed": [session_id]}
            replay = await asyncio.wait_for(
                client.request("session/replay", {"session_id": session_id, "after_cursor": 0}), 10)
            assert replay == {"events": [], "cursor": 0}
        finally:
            await client.stop()  # terminates the subprocess
            assert transport._process is None

    asyncio.run(scenario())
