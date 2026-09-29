"""Real non-TTY CLI, worker and local provider; sockets gate process completion."""
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import socket
import subprocess
import sys
import threading

import pytest

from helpers.fake_openai_server import FakeOpenAIServer
from agent.infrastructure.environment import detect_default_shell


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is required for the CLI")
def test_run_waits_for_continuation_created_tasks_and_prints_final_once(tmp_path):
    root = Path(__file__).resolve().parents[1]
    provider = FakeOpenAIServer()
    provider.start()
    gate = socket.socket()
    gate.bind(("127.0.0.1", 0))
    gate.listen(2)
    gate.settimeout(25)
    script = tmp_path / "gated.py"
    script.write_text(
        "import socket\n"
        f"with socket.create_connection(('127.0.0.1', {gate.getsockname()[1]})) as peer:\n"
        "    peer.recv(1)\n"
        "print('task done')\n", encoding="utf-8")
    if detect_default_shell().backend == "powershell":
        quote = lambda text: "'" + str(text).replace("'", "''") + "'"
        command = f"& {quote(sys.executable)} {quote(script)}"
    else:
        command = f"{shlex.quote(Path(sys.executable).as_posix())} {shlex.quote(script.as_posix())}"
    for number in (1, 2):
        provider.script_tool_call("bash", {"command": command, "yield_time_ms": 0},
                                  then_text=[f"Waiting for task {number}"], call_id=f"call_task_{number}")
    provider.script_text(["FINAL RESULT"])
    settings = tmp_path / ".rind" / "settings.json"
    settings.parent.mkdir()
    settings.write_text(json.dumps({"provider": "openai-compatible", "model": "fake-model",
                                    "apiKey": "local-test", "baseUrl": provider.base_url}), encoding="utf-8")
    env = {**os.environ, "RIND_HOME": str(tmp_path / "home"), "RIND_PYTHON": sys.executable,
           "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    env.pop("RIND_RUNTIME", None)
    env.pop("RIND_WORKSPACE", None)
    process = subprocess.Popen([shutil.which("node"), str(root / "frontend-cli/bin/rind.js"),
                                "run", "--dir", str(tmp_path), "--prompt", "run two gated tasks"],
                               cwd=tmp_path, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    errors = []
    stages = queue.Queue()

    def read_progress():
        for line in process.stderr:
            errors.append(line)
            if "Waiting for task" in line:
                stages.put(line)

    reader = threading.Thread(target=read_progress)
    reader.start()
    try:
        for number in (1, 2):
            with gate.accept()[0] as peer:
                assert f"Waiting for task {number}" in stages.get(timeout=25)
                assert process.poll() is None
                assert len(provider.requests) == number * 2, errors
                peer.sendall(b"x")
        process.wait(timeout=30)
        reader.join(timeout=5)
        stdout = process.stdout.read()
        assert process.returncode == 0, "".join(errors)
        assert stdout.strip() == "FINAL RESULT"
        assert len(provider.requests) == 5
        assert "\x1b" not in stdout + "".join(errors)
        notifications = [message for message in provider.requests[-1]["messages"]
                         if message["role"] == "user" and "task_completed" in str(message.get("content"))]
        assert len(notifications) == 2
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
        reader.join(timeout=5)
        gate.close()
        provider.stop()
