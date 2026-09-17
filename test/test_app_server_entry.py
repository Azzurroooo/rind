import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.version import __version__

import main as rind_main


def test_app_server_command_delegates_to_stdio_entry(monkeypatch):
    received = []

    def fake_app_server(argv, *, server_class):
        received.append((argv, server_class))
        return 17

    monkeypatch.setattr("agent.runtime.server.app_server.main", fake_app_server)

    assert rind_main.main(["app-server", "--stdio", "--cwd", "workspace"]) == 17
    assert received[0][0] == ["--stdio", "--cwd", "workspace"]


def test_app_server_web_command_selects_web_transport(monkeypatch):
    received = []

    def fake_app_server(argv, *, server_class):
        received.append((argv, server_class))
        return 17

    monkeypatch.setattr("agent.runtime.server.app_server.main", fake_app_server)

    assert rind_main.main(["app-server", "--web", "--port", "9000"]) == 17
    assert received[0][0] == ["--web", "--port", "9000"]
    assert received[0][1].__name__ == "WebRuntimeServer"


def test_app_server_bootstraps_default_user_settings(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind-home"))

    class FakeWorker:
        def __init__(self, **kwargs):
            self.options = kwargs

    class FakeServer:
        worker_mode = True
        network_mode = False

        def __init__(self, worker, **kwargs):
            self.worker = worker

        async def run(self):
            return 0

    from agent.runtime.server.app_server import async_main

    monkeypatch.setattr("agent.runtime.server.worker.RuntimeWorker", FakeWorker)
    assert asyncio.run(async_main(["--stdio", "--cwd", str(workspace)], server_class=FakeServer)) == 0

    settings = json.loads((tmp_path / "rind-home" / "settings.json").read_text(encoding="utf-8"))
    assert settings["apiKey"] == ""
    assert settings["model"] == "gpt-4o-mini"


def test_app_server_stdio_subprocess_smoke(tmp_path):
    workspace = tmp_path / "workspace"
    rind_home = tmp_path / "rind-home"
    workspace.mkdir()
    rind_home.mkdir()
    (rind_home / "settings.json").write_text(
        json.dumps(
            {
                "model": "test-model",
                "apiKey": "test-key",
                "baseUrl": "https://example.com/v1",
            }
        ),
        encoding="utf-8",
    )
    environment = {**os.environ, "RIND_HOME": str(rind_home)}
    command = [sys.executable, "main.py", "app-server"]
    process = subprocess.Popen(
        [
            *command,
            "--stdio",
            "--cwd",
            str(workspace),
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    try:
        process.stdin.write('{"kind":"request","request_id":"initialize-1","method":"initialize","params":{}}\n')
        process.stdin.flush()
        initialize = json.loads(process.stdout.readline())
        process.stdin.write('{"kind":"request","request_id":"shutdown-1","method":"shutdown","params":{}}\n')
        process.stdin.flush()
        shutdown = json.loads(process.stdout.readline())
        process.stdin.close()
        process.stdin = None
        remaining_stdout, stderr = process.communicate(timeout=10)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)

    assert process.returncode == 0, stderr
    assert remaining_stdout == ""
    assert initialize["kind"] == "response"
    assert initialize["request_id"] == "initialize-1"
    assert initialize["result"]["protocol_version"] == "2"
    assert initialize["result"]["version"] == __version__
    assert shutdown == {
        "kind": "response",
        "request_id": "shutdown-1",
        "result": {"ok": True},
    }
