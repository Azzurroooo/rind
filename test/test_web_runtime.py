from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import websockets

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.web import WebRuntimeServer


class _Repository:
    async def replay(self, _session_id, **_kwargs):
        return {"messages": []}


class _Execution:
    def __init__(self):
        self.started = asyncio.Event()
        self.finished = asyncio.Event()
        self.turn_id = ""

    def active_session_ids(self):
        return set()

    def active_turn_id(self, _session_id):
        return self.turn_id

    async def run_turn(self, _session_id, **_kwargs):
        self.turn_id = "turn-web"
        self.started.set()
        yield {"type": "turn_started", "session_id": "session-web", "turn_id": self.turn_id}
        await asyncio.sleep(0.05)
        self.finished.set()
        self.turn_id = ""
        yield {"type": "turn_completed", "session_id": "session-web", "turn_id": "turn-web"}


class _Worker:
    session_id = "session-web"
    workspace_root = "."
    repository = _Repository()
    execution = None

    def __init__(self):
        self.execution = _Execution()

    async def initialize(self):
        return {
            "session_id": self.session_id,
            "model": "test-model",
            "reasoning_effort": "high",
            "workspace_root": ".",
            "message_count": 0,
            "goal": None,
            "live_turn": None,
        }

    async def close(self):
        return None


def test_web_runtime_accepts_initialize_and_rejects_invalid_json():
    async def run():
        runtime = WebRuntimeServer(_Worker())
        async with websockets.serve(runtime._handle_connection, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}") as websocket:
                await websocket.send(json.dumps({"kind": "request", "request_id": 1, "method": "initialize"}))
                initialize = json.loads(await websocket.recv())
                assert initialize["result"]["session_id"] == "session-web"
                await websocket.send("not-json")
                invalid = json.loads(await websocket.recv())
                assert invalid["error"]["type"] == "ParseError"

    asyncio.run(run())


def test_web_disconnect_does_not_cancel_a_running_turn():
    async def run():
        worker = _Worker()
        runtime = WebRuntimeServer(worker)
        async with websockets.serve(runtime._handle_connection, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            websocket = await websockets.connect(f"ws://127.0.0.1:{port}")
            await websocket.send(json.dumps({"kind": "request", "request_id": 1, "method": "initialize"}))
            await websocket.recv()
            await websocket.send(json.dumps({
                "kind": "request",
                "request_id": 2,
                "method": "session/prompt",
                "params": {"session_id": "session-web", "input": "continue"},
            }))
            await worker.execution.started.wait()
            await websocket.close()
            await asyncio.wait_for(worker.execution.finished.wait(), timeout=1)

    asyncio.run(run())
