"""Run a FakeOpenAIServer forever with N pre-scripted replies.

Manual companion for user-journey testing (e.g. driving the real web surface
from a browser): python test/helpers/fake_model_runner.py --port 9100
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers.fake_openai_server import FakeOpenAIServer


def main() -> int:
    parser = argparse.ArgumentParser(description="persistent fake OpenAI-compatible model server")
    parser.add_argument("--port", type=int, default=9100)
    parser.add_argument("--replies", type=int, default=50)
    parser.add_argument("--text", default="收到！这是浏览器旅程的流式回复，一切正常。")
    args = parser.parse_args()

    server = FakeOpenAIServer()
    for _ in range(args.replies):
        server.script_text(list(args.text), delay_ms=25)
    server.start(args.port)
    # Re-script forever: every consumed reply gets pushed back so the queue
    # never runs dry during an interactive session.
    import threading

    def refill():
        while True:
            threading.Event().wait(2)
            while server.request_count() >= 0 and len(server._script) < 5:
                server.script_text(list(args.text), delay_ms=25)

    threading.Thread(target=refill, daemon=True).start()
    print(f"fake model server on {server.base_url} (ctrl+c to stop)", flush=True)
    threading.Event().wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
