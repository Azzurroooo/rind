from __future__ import annotations

import asyncio
import json
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosedError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.web import WebRuntimeServer

TOKEN = "auth-suite-token"


class _Repository:
    async def replay(self, _session_id, **_kwargs):
        return {"messages": []}


class _Execution:
    def __init__(self):
        self.turn_id = ""

    def active_session_ids(self):
        return set()

    def active_turn_id(self, _session_id):
        return self.turn_id


class _Worker:
    session_id = "session-auth"
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


def make_server(**kwargs) -> Any:
    return WebRuntimeServer(_Worker(), host="127.0.0.1", port=0, **kwargs)._serve()


def http_get(port: int, path: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")


async def fetch_ticket(port: int, authorization: str | None = None) -> tuple[int, str, str]:
    headers = {"Authorization": authorization} if authorization else None
    status, body = await asyncio.to_thread(http_get, port, "/ticket", headers)
    return status, body, ticket_of(body)


def ticket_of(body: str) -> str:
    try:
        return str(json.loads(body).get("ticket", ""))
    except json.JSONDecodeError:
        return ""


async def assert_rejected(port: int, path: str = "", **kwargs) -> None:
    try:
        websocket = await websockets.connect(f"ws://127.0.0.1:{port}{path}", **kwargs)
    except ConnectionClosedError as exc:
        assert exc.rcvd is not None and exc.rcvd.code == 4401
        assert TOKEN not in str(exc)
        return
    try:
        await websocket.recv()
        raise AssertionError("connection should have been rejected")
    except ConnectionClosedError as exc:
        assert exc.rcvd is not None and exc.rcvd.code == 4401
        assert exc.rcvd.reason == ""
        assert TOKEN not in str(exc)
    finally:
        await websocket.close()


async def initialize_ok(websocket) -> None:
    await websocket.send(json.dumps({"kind": "request", "request_id": 1, "method": "initialize"}))
    response = json.loads(await websocket.recv())
    assert response["result"]["session_id"] == "session-auth"


def test_correct_token_handshake_allows_initialize():
    async def run():
        async with make_server(server_token=TOKEN) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}?token={TOKEN}") as websocket:
                await initialize_ok(websocket)

    asyncio.run(run())


def test_wrong_or_missing_token_rejects_with_4401():
    async def run():
        async with make_server(server_token=TOKEN) as server:
            port = server.sockets[0].getsockname()[1]
            await assert_rejected(port, "?token=wrong-token")
            await assert_rejected(port)

    asyncio.run(run())


def test_ticket_exchange_grants_one_handshake_only():
    async def run():
        async with make_server(server_token=TOKEN) as server:
            port = server.sockets[0].getsockname()[1]
            status, body, ticket = await fetch_ticket(port, f"Bearer {TOKEN}")
            assert status == 200
            assert ticket
            async with websockets.connect(f"ws://127.0.0.1:{port}?ticket={ticket}") as websocket:
                await initialize_ok(websocket)
            await assert_rejected(port, f"?ticket={ticket}")

            status, body, _ = await fetch_ticket(port)
            assert status == 401
            assert TOKEN not in body
            status, body, _ = await fetch_ticket(port, "Bearer wrong-token")
            assert status == 401
            assert TOKEN not in body

    asyncio.run(run())


def test_expired_ticket_is_rejected():
    async def run():
        async with make_server(server_token=TOKEN, ticket_ttl_seconds=0.1) as server:
            port = server.sockets[0].getsockname()[1]
            status, _, ticket = await fetch_ticket(port, f"Bearer {TOKEN}")
            assert status == 200
            await asyncio.sleep(0.3)
            await assert_rejected(port, f"?ticket={ticket}")

    asyncio.run(run())


def test_cross_origin_browser_handshake_is_rejected():
    async def run():
        async with make_server(server_token=TOKEN) as server:
            port = server.sockets[0].getsockname()[1]
            await assert_rejected(port, f"?token={TOKEN}", origin="http://evil.example:1234")
            async with websockets.connect(
                f"ws://127.0.0.1:{port}?token={TOKEN}", origin=f"http://127.0.0.1:{port}"
            ) as websocket:
                await initialize_ok(websocket)

    asyncio.run(run())


def test_non_loopback_bind_without_token_refuses_to_start(capsys):
    async def run():
        host = socket.gethostbyname(socket.gethostname())
        if host.startswith("127."):
            host = "192.0.2.1"
        runtime = WebRuntimeServer(_Worker(), host=host, port=0)
        return await runtime.run()

    assert asyncio.run(run()) == 2
    assert "server token" in capsys.readouterr().err


def test_healthz_answers_without_auth_even_when_token_configured():
    async def run():
        async with make_server(server_token=TOKEN) as server:
            port = server.sockets[0].getsockname()[1]
            status, body = await asyncio.to_thread(http_get, port, "/healthz")
            assert status == 200
            assert json.loads(body) == {"ok": True}

    asyncio.run(run())


def test_loopback_without_token_keeps_zero_auth_back_compat():
    async def run():
        async with make_server() as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}") as websocket:
                await initialize_ok(websocket)
            status, body = await asyncio.to_thread(http_get, port, "/healthz")
            assert status == 200
            assert json.loads(body) == {"ok": True}
            status, body, _ = await fetch_ticket(port)
            assert status == 404

    asyncio.run(run())
