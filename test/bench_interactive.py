"""Launch the real interactive CLI against an isolated local replay provider.

Run in a visible terminal: python test/bench_interactive.py
Enter any prompt to start the fixture, then /exit to clean up.
This supplies a repeatable workload, not a public performance score.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from helpers.fake_openai_server import FakeOpenAIServer


def main() -> None:
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
            settings = workspace / ".rind" / "settings.json"
            settings.parent.mkdir(parents=True)
            settings.write_text(json.dumps({
                "provider": "openai-compatible", "model": "fake-model",
                "apiKey": "local-fixture-only", "baseUrl": server.base_url,
            }), encoding="utf-8")
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith("RIND_")}
            env.update(RIND_HOME=str(temporary / "home"), PYTHONUTF8="1")
            command = ["node", str(root / "frontend-cli/bin/rind.js"), "--cwd", str(workspace)]
            print(json.dumps({
                "command": command, "tty": True, "provider_pid": os.getpid(),
                "fixture_sha256": hashlib.sha256(json.dumps(fixture).encode()).hexdigest(),
                "sha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
                "note": "Local provider only. Record terminal, UI evidence and process-tree samples separately.",
            }, ensure_ascii=False), flush=True)
            subprocess.run(command, cwd=root, env=env, check=True)
    finally:
        server.stop()


if __name__ == "__main__":
    main()
