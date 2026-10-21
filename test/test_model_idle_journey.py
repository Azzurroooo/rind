"""User journey: a model connection that stays open but sends nothing must not hold a turn forever.

A real worker subprocess talks to a fake OpenAI server that opens the stream and
then only sends keep-alive comments. The idle limit is lowered in the worker so
the journey runs in seconds.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "test"))

from helpers.fake_openai_server import FakeOpenAIServer
from test_journeys_user import TOKEN, JourneyClient, _free_port, _fresh_session, _run_prompt_turn

LAUNCH_WITH_SHORT_IDLE_LIMIT = (
    "import runpy, agent.infrastructure.llm.cancellation as c; "
    "c.MODEL_IDLE_TIMEOUT_SECONDS = 1; "
    "runpy.run_path('main.py', run_name='__main__')"
)


@pytest.fixture(scope="module")
def stalling_worker(tmp_path_factory):
    root = tmp_path_factory.mktemp("idle")
    workspace = root / "workspace"
    workspace.mkdir()
    home = root / "home"
    home.mkdir()
    server = FakeOpenAIServer()
    server.start()
    (home / "settings.json").write_text(json.dumps({"provider": "openai", "model": "fake-model"}), encoding="utf-8")
    (home / "auth.json").write_text(json.dumps({"openai": {"type": "api_key", "key": "test-key"}}), encoding="utf-8")
    (home / "providers.json").write_text(
        json.dumps({"providers": {"openai": {"api": "openai-chat", "baseUrl": server.base_url}}}), encoding="utf-8",
    )
    port = _free_port()
    env = {**os.environ, "RIND_SERVER_TOKEN": TOKEN, "RIND_HOME": str(home), "PYTHONUTF8": "1"}
    process = subprocess.Popen(
        [sys.executable, "-c", LAUNCH_WITH_SHORT_IDLE_LIMIT, "app-server", "--web", "--host", "127.0.0.1",
         "--port", str(port), "--cwd", str(workspace), "--session-dir", str(root / "sessions")],
        cwd=PROJECT_ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 30
    while True:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2):
                break
        except Exception:
            if time.monotonic() > deadline:
                process.kill()
                raise RuntimeError("worker never became healthy")
            time.sleep(0.2)
    worker = type("Worker", (), {"ws_url": f"ws://127.0.0.1:{port}", "workspace": workspace, "sessions": root / "sessions", "server": server})
    yield worker
    process.terminate()
    process.wait(timeout=10)
    server.stop()


def _of_type(events, kind):
    return [envelope["event"] for envelope in events if envelope["event"].get("type") == kind]


def test_a_stalled_stream_is_retried_and_the_reply_arrives(stalling_worker):
    async def run():
        client = JourneyClient(f"{stalling_worker.ws_url}?token={TOKEN}")
        await client.connect()
        try:
            session_id = await _fresh_session(stalling_worker, client)
            stalling_worker.server.script_stall()
            stalling_worker.server.script_text(["Back ", "online."])
            events, _ = await _run_prompt_turn(client, session_id, "hello", timeout=30)
            assert len(_of_type(events, "turn_step_retry")) == 1
            assert _of_type(events, "turn_completed")
            assert "Back online." in "".join(event.get("text", "") for event in _of_type(events, "assistant_delta"))
        finally:
            await client.close()

    asyncio.run(run())


def test_a_model_that_never_answers_fails_the_turn_and_frees_the_session(stalling_worker):
    async def run():
        client = JourneyClient(f"{stalling_worker.ws_url}?token={TOKEN}")
        await client.connect()
        try:
            session_id = await _fresh_session(stalling_worker, client)
            for _ in range(4):
                stalling_worker.server.script_stall()
            events, _ = await _run_prompt_turn(client, session_id, "hello", timeout=60)
            failed = _of_type(events, "turn_failed")
            assert failed and "sent nothing" in failed[0]["error"]
            meta = json.loads((stalling_worker.sessions / session_id / "meta.json").read_text(encoding="utf-8"))
            assert meta["turn_state"]["status"] == "failed"

            stalling_worker.server.script_text(["Still here."])
            events, _ = await _run_prompt_turn(client, session_id, "again", timeout=30)
            assert _of_type(events, "turn_completed")
        finally:
            await client.close()

    asyncio.run(run())
