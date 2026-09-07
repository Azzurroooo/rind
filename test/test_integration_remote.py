"""End-to-end integration: a real app-server --web subprocess driven by the
gateway's own WorkerClient — the exact path the web surface and the gateway
share (J8 server-side contract plus session/file/replay coverage)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway.worker_client import WorkerClient

TOKEN = "integration-suite-token"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_healthz(port: int, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/healthz"
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200 and json.loads(response.read().decode()) == {"ok": True}:
                    return
        except Exception as exc:  # noqa: BLE001 - startup polling
            last_error = exc
        time.sleep(0.2)
    raise RuntimeError(f"worker /healthz never became ready: {last_error}")


@pytest.fixture()
def worker_port(tmp_path):
    port = _free_port()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    home = tmp_path / "home"
    (home / ".rind").mkdir(parents=True)
    env = dict(os.environ)
    env.update(
        {
            "RIND_SERVER_TOKEN": TOKEN,
            "RIND_HOME": str(home),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        }
    )
    env.pop("RIND_WORKSPACE", None)
    process = subprocess.Popen(
        [
            sys.executable,
            str(PROJECT_ROOT / "main.py"),
            "app-server",
            "--web",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--cwd",
            str(workspace),
            "--session-dir",
            str(tmp_path / "sessions"),
        ],
        cwd=PROJECT_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_healthz(port)
        yield port, workspace
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def test_worker_serves_gateway_client_end_to_end(worker_port):
    port, workspace = worker_port

    async def run():
        client = WorkerClient(f"ws://127.0.0.1:{port}", TOKEN)
        received: list[dict] = []
        client.on_event(lambda envelope: received.append(envelope))
        try:
            await client.start()

            created = await client.request("session/new", {"workspace_root": str(workspace)})
            session_id = created["session_id"]
            assert session_id

            await client.subscribe(session_id)

            ping = await client.request("ping", {})
            assert ping == {"ok": True}

            payload = base64.b64encode("hello from the gateway".encode()).decode()
            written = await client.request(
                "file/write",
                {"path": "uploads/note.txt", "content_base64": payload},
            )
            assert written == {"path": "uploads/note.txt", "size": 22}

            listed = await client.request("file/list", {"path": "uploads"})
            assert listed["entries"] == [{"name": "note.txt", "size": 22, "type": "file"}]

            read = await client.request("file/read", {"path": "uploads/note.txt"})
            assert base64.b64decode(read["content_base64"]).decode() == "hello from the gateway"
            assert read["mime"] == "text/plain"

            replay = await client.request("session/replay", {"session_id": session_id, "after_cursor": 0})
            assert replay["cursor"] == 0 and replay["events"] == []

            sessions = await client.request("session/list", {"limit": 10})
            assert isinstance(sessions["sessions"], list)
            assert "current_session_id" in sessions

            await client.request("session/delete", {"session_id": session_id})
            with pytest.raises(Exception, match="."):
                await client.request("file/read", {"path": "../../etc/passwd"})
        finally:
            await client.stop()

    asyncio.run(run())


def test_worker_rejects_gateway_without_token(worker_port):
    port, _workspace = worker_port

    async def run():
        client = WorkerClient(f"ws://127.0.0.1:{port}", None)
        with pytest.raises(Exception):
            await client.start()
        assert not client.connected

    asyncio.run(run())
