import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import main as rind_main


def test_app_server_command_delegates_to_stdio_entry(monkeypatch):
    received = []

    def fake_app_server(argv, *, server_class):
        received.append((argv, server_class))
        return 17

    monkeypatch.setattr("agent.interfaces.runtime_server.app_server.main", fake_app_server)

    assert rind_main.main(["app-server", "--stdio", "--cwd", "workspace"]) == 17
    assert received[0][0] == ["--stdio", "--cwd", "workspace"]


@pytest.mark.parametrize("entrypoint", ("app-server", "stdio-module"))
def test_app_server_stdio_subprocess_smoke(tmp_path, entrypoint):
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
    if entrypoint == "app-server":
        command = [sys.executable, "main.py", "app-server"]
    else:
        command = [
            sys.executable,
            "-c",
            "import runpy; runpy.run_module('agent.interfaces.runtime_server.stdio', run_name='__main__')",
        ]
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
        process.stdin.write('{"request_id":"initialize-1","method":"initialize","params":{}}\n')
        process.stdin.flush()
        initialize = json.loads(process.stdout.readline())
        process.stdin.write('{"request_id":"shutdown-1","method":"shutdown","params":{}}\n')
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
    assert initialize["result"]["protocol_version"] == "1"
    assert shutdown == {
        "kind": "response",
        "request_id": "shutdown-1",
        "result": {"ok": True},
    }
