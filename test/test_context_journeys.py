"""User-seat /context journeys: a real worker subprocess speaking the same
stdio JSONL transport the CLI drives, scripted by the fake model server.

These assert what a user perceives after real turns — the board's numbers —
not implementation details: composition rows after a chat exchange, tool
rows after bash use, the compaction-handoff row and page-2 counter after
/compact, and a snapshot that follows a fork."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(PROJECT_ROOT / "test") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "test"))

from helpers.fake_openai_server import FakeOpenAIServer


class StdioWorkerClient:
    """The CLI's seat: JSONL requests and event envelopes over worker stdio."""

    def __init__(self, process):
        self._process = process
        self._lock = threading.Lock()
        self._responses: dict[object, dict] = {}
        self._events: list[dict] = []

        def _pump():
            for line in self._process.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    envelope = json.loads(line)
                except ValueError:
                    continue
                with self._lock:
                    if envelope.get("kind") == "response":
                        self._responses[envelope.get("request_id")] = envelope
                    elif envelope.get("kind") == "event":
                        self._events.append(envelope)

        self._pump_thread = threading.Thread(target=_pump, daemon=True)
        self._pump_thread.start()

    def request(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        request_id = f"req-{time.monotonic_ns()}"
        payload = {"kind": "request", "request_id": request_id, "method": method, "params": params or {}}
        with self._lock:
            self._responses.pop(request_id, None)
        self._process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._process.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                envelope = self._responses.pop(request_id, None)
            if envelope is not None:
                if "error" in envelope:
                    raise AssertionError(f"{method} failed: {envelope['error']}")
                return envelope.get("result") or {}
            time.sleep(0.02)
        raise TimeoutError(f"{method} timed out")

    def run_prompt(self, session_id: str, text: str, timeout: float = 90.0) -> dict:
        return self.request("session/prompt", {"session_id": session_id, "input": text}, timeout=timeout)

    def ledger_rows(self, home: Path) -> list[dict]:
        ledger = home / "usage.jsonl"
        if not ledger.exists():
            return []
        return [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]


@pytest.fixture(scope="module")
def context_worker(tmp_path_factory):
    """One real worker subprocess; a scratch workspace plus scratch RIND_HOME."""
    root = tmp_path_factory.mktemp("context-journey")
    workspace = root / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / ".rind" / "settings.json").write_text(
        json.dumps({"model": "fake-model", "apiKey": "test-key", "baseUrl": "http://127.0.0.1:9/v1"}),
        encoding="utf-8",
    )
    home = root / "home"
    (home / ".rind").mkdir(parents=True)
    env = dict(os.environ)
    env.update({"RIND_HOME": str(home), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    env.pop("RIND_WORKSPACE", None)
    process = subprocess.Popen(
        [
            sys.executable, str(PROJECT_ROOT / "main.py"), "app-server", "--stdio",
            "--cwd", str(workspace), "--session-dir", str(root / "sessions"),
        ],
        cwd=PROJECT_ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
    )
    yield type("Worker", (), {
        "client": StdioWorkerClient(process),
        "workspace": workspace,
        "home": home,
        "process": process,
    })()
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


@pytest.fixture()
def model_server(context_worker):
    server = FakeOpenAIServer()
    server.start()
    settings_path = context_worker.workspace / ".rind" / "settings.json"
    settings_path.write_text(
        json.dumps({"model": "fake-model", "apiKey": "test-key", "baseUrl": server.base_url}),
        encoding="utf-8",
    )
    yield server
    server.stop()


def _summarize_breakdown(result: dict) -> dict:
    breakdown = result.get("breakdown") or {}
    return {
        section["key"]: section
        for section in breakdown.get("sections") or []
    }


def test_jc1_fresh_exchange_shows_board_rows_with_small_deviation(context_worker, model_server):
    client = context_worker.client
    info = client.request("initialize", {})
    session_id = info["session_id"]
    model_server.script_text(["你好", "，很高兴见到你。"], delay_ms=1)
    client.run_prompt(session_id, "打个招呼")

    board = client.request("rind/context/inspect", {"session_id": session_id})
    sections = _summarize_breakdown(board)
    breakdown = board["breakdown"]

    # Page 1 shows the composition of the LAST SAMPLING: after one exchange the
    # reply was persisted after that sampling, so the fresh board shows three
    # rows — system prompt, goal policy, and the user's message.
    assert "chat_user" in sections
    assert "system_prompt" in sections
    assert "goal_policy" in sections
    # Assembly order: the system prompt row always leads the board.
    assert breakdown["sections"][0]["key"] == "system_prompt"
    # Every number on page 1 traces to the snapshot: rows sum to the total.
    assert sum(section["tokens"] for section in breakdown["sections"]) == breakdown["estimated_total"]
    assert breakdown["context_window_tokens"] > 0
    assert breakdown["turn_id"]
    # The measured total anchors the page; deviation stays well under 15%.
    usage = board["latest_usage"]
    assert usage is not None and usage["input_tokens"] > 0
    deviation = abs(usage["input_tokens"] - breakdown["estimated_total"]) / usage["input_tokens"]
    assert deviation < 0.15, f"estimated {breakdown['estimated_total']} vs measured {usage['input_tokens']}"

    # A second exchange samples WITH the first reply in context: the assistant
    # row appears and the tools segment is still absent.
    model_server.script_text(["第二次回答"], delay_ms=1)
    client.run_prompt(session_id, "再问一句")
    board = client.request("rind/context/inspect", {"session_id": session_id})
    sections = _summarize_breakdown(board)
    assert "chat_assistant" in sections
    assert sections["chat_assistant"]["messages"] >= 1

    summary = client.request("rind/usage/summary", {"days": 7})
    assert summary["totals"]["samples"] >= 2
    assert summary["totals"]["input"] >= usage["input_tokens"]
    rows = client.ledger_rows(context_worker.home)
    assert any(row["session_id"] == session_id and row["sampling_kind"] == "assistant" for row in rows)


def test_jc2_bash_calls_widen_the_tool_segment(context_worker, model_server):
    client = context_worker.client
    info = client.request("initialize", {})
    session_id = info["session_id"]
    model_server.script_tool_call("bash", {"command": "echo journey-context"}, then_text=["done"])
    client.run_prompt(session_id, "run echo via bash")

    board = client.request("rind/context/inspect", {"session_id": session_id})
    sections = _summarize_breakdown(board)

    assert "tool:bash" in sections, f"tool rows missing: {sorted(sections)}"
    assert sections["tool:bash"]["messages"] >= 1
    assert board["breakdown"]["sections"][0]["key"] == "system_prompt"
    assert sum(section["tokens"] for section in board["breakdown"]["sections"]) == board["breakdown"]["estimated_total"]


def test_jc3_compact_replaces_history_and_counts_compactions(context_worker, model_server):
    client = context_worker.client
    info = client.request("initialize", {})
    session_id = info["session_id"]
    model_server.script_text(["first answer"], delay_ms=1)
    client.run_prompt(session_id, "first question")

    record = client.request("rind/session/compact", {"session_id": session_id})
    assert record.get("id")

    board = client.request("rind/context/inspect", {"session_id": session_id})
    sections = _summarize_breakdown(board)
    assert "compaction_handoff" in sections, f"handoff row missing: {sorted(sections)}"
    assert "chat_user" not in sections or sections["compaction_handoff"]["tokens"] > 0
    keys = [section["key"] for section in board["breakdown"]["sections"]]
    assert keys[0] == "system_prompt"
    if "chat_user" in keys:
        assert keys.index("compaction_handoff") < keys.index("chat_user")

    summary = client.request("rind/usage/summary", {"days": 7})
    assert summary["totals"]["compactions"] >= 1
    rows = client.ledger_rows(context_worker.home)
    assert any(row["sampling_kind"] == "compact" for row in rows)


def test_jc4_fork_inherits_snapshot_and_ledger_records_new_session(context_worker, model_server):
    client = context_worker.client
    info = client.request("initialize", {})
    session_id = info["session_id"]
    model_server.script_text(["before fork"], delay_ms=1)
    client.run_prompt(session_id, "question before fork")

    forked = client.request("session/fork", {"session_id": session_id})
    new_id = forked["session_id"]

    board = client.request("rind/context/inspect", {"session_id": new_id})
    assert board["breakdown"] is not None
    assert board["breakdown"]["estimated_total"] > 0
    assert board["session_id"] == new_id

    model_server.script_text(["after fork"], delay_ms=1)
    client.run_prompt(new_id, "question after fork")
    rows = client.ledger_rows(context_worker.home)
    assert any(row["session_id"] == new_id and row["sampling_kind"] == "assistant" for row in rows)
