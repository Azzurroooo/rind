import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence import JsonlSessionStore
from agent.runtime.server.stdio import WorkerStdioRuntimeServer
from agent.runtime.server.worker import SessionRepository


class _FakeExecution:
    def __init__(self, active=None):
        self._active = set(active or ())

    def set_event_sink(self, sink):
        pass

    def active_session_ids(self):
        return set(self._active)


class _FakeWorker:
    def __init__(self, tmp_path: Path, active=None):
        self.workspace_root = str(tmp_path)
        self.session_id = "20260907_alpha"
        self.session_dir = str(tmp_path / "sessions")
        self.execution = _FakeExecution(active)
        self.repository = SessionRepository(session_dir=self.session_dir)

    async def fork_session(self, session_id: str, before_message_id: str | None = None) -> dict:
        return await self.repository.fork(session_id, before_message_id)


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
    return {"kind": "request", "request_id": f"{method}-1", "method": method, "params": params}


def _last(server: WorkerStdioRuntimeServer) -> dict:
    return server._writer._writer.payloads[-1]


def _seed_history(worker: _FakeWorker, session_id: str = "20260907_alpha") -> None:
    async def _run() -> None:
        store = JsonlSessionStore(
            session_dir=worker.session_dir,
            session_id=session_id,
            system_prompt="sys",
            workspace_root=worker.workspace_root,
        )
        await store.initialize()
        await store.persist_message("user", "first question")
        await store.persist_message("assistant", "first answer")
        await store.persist_message("user", "second question")

    asyncio.run(_run())


def _messages(worker: _FakeWorker, session_id: str) -> list[dict]:
    base = Path(worker.session_dir) / session_id
    return [json.loads(line) for line in (base / "messages.jsonl").read_text(encoding="utf-8").splitlines() if line]


def test_fork_returns_new_session_and_lists_it(tmp_path):
    worker = _FakeWorker(tmp_path)
    _seed_history(worker)

    server = _make_server(worker)
    asyncio.run(server.dispatch(_request("session/fork", {"session_id": "20260907_alpha"})))

    result = _last(server)["result"]
    assert result["forked_from"] == "20260907_alpha"
    assert result["session_id"] != "20260907_alpha"
    assert _messages(worker, result["session_id"]) == _messages(worker, "20260907_alpha")

    listed = JsonlSessionStore.list_session_metadata(worker.session_dir, limit=10, workspace_root=str(tmp_path))
    assert result["session_id"] in {entry["id"] for entry in listed}


def test_fork_before_message_truncates_history(tmp_path):
    worker = _FakeWorker(tmp_path)
    _seed_history(worker)
    before_id = next(m["id"] for m in _messages(worker, "20260907_alpha") if m.get("content") == "second question")

    server = _make_server(worker)
    asyncio.run(
        server.dispatch(_request("session/fork", {"session_id": "20260907_alpha", "before_message_id": before_id}))
    )

    result = _last(server)["result"]
    assert _messages(worker, result["session_id"]) == _messages(worker, "20260907_alpha")[:3]


def test_fork_refuses_session_with_active_turn(tmp_path):
    worker = _FakeWorker(tmp_path, active={"20260907_alpha"})
    _seed_history(worker)

    server = _make_server(worker)
    asyncio.run(server.dispatch(_request("session/fork", {"session_id": "20260907_alpha"})))

    assert _last(server)["error"]["type"] == "TurnActive"


def test_fork_maps_validation_errors_to_invalid_request(tmp_path):
    worker = _FakeWorker(tmp_path)
    _seed_history(worker)

    server = _make_server(worker)
    asyncio.run(
        server.dispatch(_request("session/fork", {"session_id": "20260907_alpha", "before_message_id": "missing"}))
    )
    assert _last(server)["error"]["type"] == "InvalidRequest"

    asyncio.run(server.dispatch(_request("session/fork", {"session_id": "20990101_missing"})))
    assert _last(server)["error"]["type"] == "SessionNotFound"

    asyncio.run(server.dispatch(_request("session/fork", {"session_id": "20260907_alpha", "before_message_id": 7})))
    assert _last(server)["error"]["type"] == "InvalidRequest"


def test_fork_refuses_delegated_sessions(tmp_path):
    worker = _FakeWorker(tmp_path)
    _seed_history(worker)
    meta_path = Path(worker.session_dir) / "20260907_alpha" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["session_type"] = "delegated_task"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    server = _make_server(worker)
    asyncio.run(server.dispatch(_request("session/fork", {"session_id": "20260907_alpha"})))

    assert _last(server)["error"]["type"] == "InvalidRequest"
    assert "Delegated" in _last(server)["error"]["message"]


def test_fork_does_not_steal_the_current_subscription(tmp_path):
    worker = _FakeWorker(tmp_path)
    _seed_history(worker)

    server = _make_server(worker)
    server._subscribed.add("20260907_alpha")
    asyncio.run(server.dispatch(_request("session/fork", {"session_id": "20260907_alpha"})))

    result = _last(server)["result"]
    assert server._subscribed == {"20260907_alpha"}
    assert result["session_id"] not in server._subscribed
