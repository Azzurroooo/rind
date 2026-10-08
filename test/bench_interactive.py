"""Launch the real interactive CLI against an isolated local replay provider.

Run in a visible terminal: python test/bench_interactive.py
Enter any prompt to start the fixture, then /exit to clean up.
This supplies a repeatable workload, not a public performance score.
"""

from __future__ import annotations

import argparse
from contextlib import redirect_stderr
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import psutil
from helpers.fake_openai_server import FakeOpenAIServer


def observe_children(root: psutil.Process, owned: dict[int, psutil.Process]) -> None:
    try:
        for child in root.children(recursive=True):
            owned[child.pid] = child
    except psutil.NoSuchProcess:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, help="Write launch identities for the external sampler")
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SystemExit("A visible interactive terminal is required; redirected runs are invalid.")
    root = Path(__file__).resolve().parents[1]
    chunks = [f"Streaming line {index:03d}: 中文 é 👩‍💻 and `code`.\n" for index in range(240)]
    fixture = {"chunks": chunks, "delay_ms": 25}
    server = FakeOpenAIServer()
    server.script_text(**fixture)
    server.start()
    try:
        with tempfile.TemporaryDirectory(prefix="rind-bench-") as directory:
            temporary = Path(directory)
            workspace = temporary / "workspace"
            workspace.mkdir()
            settings = temporary / "home" / "settings.json"
            settings.parent.mkdir()
            settings.write_text(json.dumps({
                "provider": "openai-compatible", "model": "fake-model",
                "apiKey": "local-fixture-only", "baseUrl": server.base_url,
            }), encoding="utf-8")
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith("RIND_")}
            env.update(RIND_HOME=str(temporary / "home"), PYTHONUTF8="1")
            command = ["node", str(root / "frontend-cli/bin/rind.js"), "--cwd", str(workspace)]
            manifest = {
                "command": command, "tty": True, "provider_pid": os.getpid(),
                "fixture_sha256": hashlib.sha256(json.dumps(fixture).encode()).hexdigest(),
                "sha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
                "public_score_eligible": False,
                "note": "Local provider only. TTY does not prove visible rendering; record UI evidence separately.",
            }
            if sys.platform == "win32":
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.GetConsoleWindow.restype = ctypes.c_void_p
                terminal_pid = ctypes.c_ulong()
                user = ctypes.WinDLL("user32", use_last_error=True)
                user.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
                user.GetWindowThreadProcessId(kernel.GetConsoleWindow(), ctypes.byref(terminal_pid))
                manifest["console_host_pid"] = terminal_pid.value
            with (temporary / "provider.log").open("w", encoding="utf-8") as log, redirect_stderr(log):
                process = subprocess.Popen(command, cwd=root, env=env)
                owned = {process.pid: psutil.Process(process.pid)}
                try:
                    manifest["agent_pid"] = process.pid
                    if args.manifest:
                        with args.manifest.open("x", encoding="utf-8") as output:
                            json.dump(manifest, output, indent=2)
                    while process.poll() is None:
                        observe_children(owned[process.pid], owned)
                        try:
                            process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            pass
                finally:
                    observe_children(owned[process.pid], owned)
                    for child in reversed(list(owned.values())):
                        try:
                            if child.is_running():
                                child.terminate()
                        except psutil.NoSuchProcess:
                            pass
                    _, alive = psutil.wait_procs(list(owned.values()), timeout=5)
                    if alive:
                        raise RuntimeError(f"Test cleanup failed for PIDs {[child.pid for child in alive]}")
                    process.wait()
                if process.returncode:
                    raise SystemExit(f"Rind exited with code {process.returncode}; fixture processes cleaned up.")
    finally:
        server.stop()


if __name__ == "__main__":
    main()
