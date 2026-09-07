import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.infrastructure.persistence.session_index_repository import SessionIndexRepository
from agent.runtime.server.stdio import WorkerStdioRuntimeServer


class _FakeExecution:
    def __init__(self, active=None):
        self._active = set(active or ())

    def set_event_sink(self, sink):
        pass

    def active_session_ids(self):
        return set(self._active)


class _FakeWorker:
    def __init__(self, tmp_path: Path, session_id: str, active=None):
        self.workspace_root = str(tmp_path)
        self.session_id = session_id
        self.session_dir = str(tmp_path / "sessions")
        self.execution = _FakeExecution(active)
        self.repository = _FakeRepository(self.session_dir)

    async def delete_session(self, session_id: str) -> dict:
        return await self.repository.delete(session_id)


class _FakeRepository:
    """Backs delete with the real persistence helpers, on a temp session root."""

    def __init__(self, session_dir: str):
        self.session_dir = session_dir

    async def delete(self, session_id: str) -> dict:
        JsonlSessionStore.load_session_metadata(session_id, self.session_dir)
        root = Path(JsonlSessionStore.resolve_session_root(self.session_dir))
        base = root / session_id
        if base.exists():
            import shutil

            shutil.rmtree(base)
        index_path = os.path.join(root, "index.json")
        SessionIndexRepository(SessionFiles(), index_path).remove_session(session_id)
        return {"session_id": session_id, "workspace_root": ""}


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


def _make_session(tmp_path: Path, session_id: str, workspace: Path) -> None:
    root = tmp_path / "sessions"
    base = root / session_id
    base.mkdir(parents=True, exist_ok=True)
    (base / "meta.json").write_text(
        json.dumps({"schema_version": "2.0", "session_id": session_id, "workspace_root": str(workspace)}),
        encoding="utf-8",
    )
    (base / "messages.jsonl").write_text("", encoding="utf-8")
    index_path = root / "index.json"
    index = SessionFiles().load_json(str(index_path)) or {"sessions": []}
    index.setdefault("sessions", []).append({"id": session_id, "workspace_root": str(workspace)})
    SessionFiles().write_json(str(index_path), index)


def _last(server: WorkerStdioRuntimeServer) -> dict:
    return server._writer._writer.payloads[-1]


def test_delete_removes_directory_and_index_entry(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    _make_session(tmp_path, "20260907_web1", workspace)
    worker = _FakeWorker(tmp_path, session_id="20260907_keep")
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("session/delete", {"session_id": "20260907_web1"})))

    response = _last(server)
    assert response["result"] == {"ok": True, "deleted": "20260907_web1"}
    assert not (tmp_path / "sessions" / "20260907_web1").exists()
    index = SessionFiles().load_json(str(tmp_path / "sessions" / "index.json"))
    assert all(entry["id"] != "20260907_web1" for entry in index["sessions"])


def test_delete_unknown_session_is_not_found(tmp_path):
    worker = _FakeWorker(tmp_path, session_id="20260907_keep")
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("session/delete", {"session_id": "20990101_missing"})))

    assert _last(server)["error"]["type"] == "SessionNotFound"


def test_delete_refuses_current_session(tmp_path):
    worker = _FakeWorker(tmp_path, session_id="20260907_now")
    _make_session(tmp_path, "20260907_now", tmp_path)
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("session/delete", {"session_id": "20260907_now"})))

    assert _last(server)["error"]["type"] == "InvalidRequest"
    assert (tmp_path / "sessions" / "20260907_now").exists()


def test_delete_refuses_session_with_active_turn(tmp_path):
    worker = _FakeWorker(tmp_path, session_id="20260907_now", active={"20260907_busy"})
    _make_session(tmp_path, "20260907_busy", tmp_path)
    server = _make_server(worker)

    asyncio.run(server.dispatch(_request("session/delete", {"session_id": "20260907_busy"})))

    assert _last(server)["error"]["type"] == "TurnActive"
    assert (tmp_path / "sessions" / "20260907_busy").exists()


def test_delete_prunes_subscription_set(tmp_path):
    worker = _FakeWorker(tmp_path, session_id="20260907_now")
    _make_session(tmp_path, "20260907_old", tmp_path)
    server = _make_server(worker)
    server._subscribed.add("20260907_old")

    asyncio.run(server.dispatch(_request("session/delete", {"session_id": "20260907_old"})))

    assert "20260907_old" not in server._subscribed


def test_ping_responds_ok_without_initialization(tmp_path):
    worker = _FakeWorker(tmp_path, session_id="20260907_now")
    server = WorkerStdioRuntimeServer(worker, writer=_CaptureWriter())

    asyncio.run(server.dispatch(_request("ping", {})))

    assert _last(server) == {"kind": "response", "request_id": "ping-1", "result": {"ok": True}}
