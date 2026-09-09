"""rind/context/inspect and rind/usage/summary protocol behavior."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.persistence.usage_ledger import append_usage_record
from agent.runtime.server.stdio import WorkerStdioRuntimeServer
from agent.runtime.server.worker import SessionRepository


SESSION_ID = "20260910_alpha"


class _FakeExecution:
    def set_event_sink(self, sink):
        pass

    def active_session_ids(self):
        return set()


class _FakeWorker:
    def __init__(self, tmp_path: Path):
        self.workspace_root = str(tmp_path)
        self.session_id = SESSION_ID
        self.session_dir = str(tmp_path / "sessions")
        self.execution = _FakeExecution()
        self.repository = SessionRepository(session_dir=self.session_dir)
        self.summary_calls = []

    async def usage_summary(self, days: int) -> dict:
        self.summary_calls.append(days)
        return {"days": days, "totals": {"samples": 0}, "by_day": [], "by_model": [], "recent_sessions": []}


class _CaptureWriter:
    def __init__(self):
        self.payloads = []

    async def send(self, payload):
        self.payloads.append(payload)


def _make_server(worker: _FakeWorker) -> WorkerStdioRuntimeServer:
    server = WorkerStdioRuntimeServer(worker, writer=_CaptureWriter())
    server._initialized = True
    return server


def _request(method: str, params: dict) -> dict:
    return {"kind": "request", "request_id": "r1", "method": method, "params": params}


def _last(server: WorkerStdioRuntimeServer) -> dict:
    return server._writer._writer.payloads[-1]


def _seed_store(worker: _FakeWorker) -> JsonlSessionStore:
    store = JsonlSessionStore(
        session_dir=worker.session_dir,
        session_id=SESSION_ID,
        system_prompt="sys",
        workspace_root=worker.workspace_root,
    )

    async def _run() -> None:
        await store.initialize()
        await store.persist_message("user", "hello")

    asyncio.run(_run())
    return store


def test_inspect_returns_meta_breakdown_and_latest_usage(tmp_path):
    worker = _FakeWorker(tmp_path)
    store = _seed_store(worker)

    async def _seed_meta():
        await store.persist_context_breakdown({
            "captured_at": "2026-09-10T00:00:00Z",
            "turn_id": "turn-1",
            "estimated_total": 321,
            "context_window_tokens": 4096,
            "sections": [{"key": "chat_user", "label": "Chat · user inputs", "tokens": 321, "messages": 1}],
        })
        await store.persist_sampling_usage({
            "sampling_kind": "assistant",
            "input_tokens": 118,
            "cached_input_tokens": 0,
            "cache_hit_rate": 0.0,
            "output_tokens": 21,
            "reasoning_output_tokens": 0,
            "total_tokens": 139,
            "context_window_tokens": 4096,
            "context_usage_percent": 118 / 4096,
        })

    asyncio.run(_seed_meta())
    server = _make_server(worker)
    asyncio.run(server.dispatch(_request("rind/context/inspect", {"session_id": SESSION_ID})))

    response = _last(server)
    assert "error" not in response
    result = response["result"]
    assert result["session_id"] == SESSION_ID
    assert result["breakdown"]["estimated_total"] == 321
    assert result["breakdown"]["sections"][0]["key"] == "chat_user"
    assert result["latest_usage"]["input_tokens"] == 118
    assert result["latest_usage"]["sampling_kind"] == "assistant"


def test_inspect_without_records_reports_an_explicit_empty_state(tmp_path):
    worker = _FakeWorker(tmp_path)
    _seed_store(worker)
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("rind/context/inspect", {"session_id": SESSION_ID})))

    result = _last(server)["result"]
    assert result["breakdown"] is None
    assert result["latest_usage"] is None


def test_inspect_unknown_session_is_session_not_found(tmp_path):
    worker = _FakeWorker(tmp_path)
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("rind/context/inspect", {"session_id": "20260910_missing"})))

    response = _last(server)
    assert response["error"]["type"] == "SessionNotFound"


def test_summary_forwards_days_and_requires_a_valid_range(tmp_path):
    worker = _FakeWorker(tmp_path)
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("rind/usage/summary", {"days": 30})))
    assert worker.summary_calls == [30]
    assert _last(server)["result"]["days"] == 30

    asyncio.run(server.dispatch(_request("rind/usage/summary", {"days": 0})))
    assert _last(server)["error"]["type"] == "InvalidRequest"

    asyncio.run(server.dispatch(_request("rind/usage/summary", {"days": "week"})))
    assert _last(server)["error"]["type"] == "InvalidRequest"
    assert worker.summary_calls == [30]


@pytest.mark.asyncio
async def test_worker_usage_summary_reads_the_real_ledger(tmp_path, monkeypatch):
    from agent.runtime.server.worker import RuntimeWorker

    monkeypatch.setenv("RIND_HOME", str(tmp_path))
    ledger = tmp_path / "usage.jsonl"
    append_usage_record(ledger, {
        "ts": "2026-09-10T10:00:00+00:00",
        "session_id": "s1",
        "model": "m1",
        "sampling_kind": "assistant",
        "input_tokens": 100,
        "cached_input_tokens": 10,
        "cache_hit_rate": 0.1,
        "output_tokens": 20,
        "reasoning_output_tokens": 5,
        "total_tokens": 120,
        "context_window_tokens": 4096,
        "context_usage_percent": 100 / 4096,
    })
    append_usage_record(ledger, {
        "ts": "2026-09-10T11:00:00+00:00",
        "session_id": "s1",
        "model": "m1",
        "sampling_kind": "compact",
        "input_tokens": 90,
        "cached_input_tokens": 0,
        "cache_hit_rate": 0.0,
        "output_tokens": 30,
        "reasoning_output_tokens": 0,
        "total_tokens": 120,
        "context_window_tokens": 4096,
        "context_usage_percent": 90 / 4096,
    })

    worker = RuntimeWorker(workspace_root=str(tmp_path))
    summary = await worker.usage_summary(7)

    assert summary["days"] == 7
    assert summary["totals"]["samples"] == 2
    assert summary["totals"]["total"] == 240
    assert summary["totals"]["compactions"] == 1
    assert summary["totals"]["input"] == 190
    assert summary["totals"]["output"] == 50
    assert summary["by_model"][0]["model"] == "m1"
    assert summary["by_model"][0]["tokens"] == 240
    assert summary["recent_sessions"][0]["session_id"] == "s1"
