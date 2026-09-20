"""Startup drafts retain their identity without creating session files."""

from __future__ import annotations

import asyncio
import gc
import json
import weakref
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.domain.errors import ProviderError
from agent.domain.models import ModelCompletion, ModelStreamEvent
from agent.infrastructure.persistence import JsonlSessionStore
from agent.runtime.server.dispatcher import RuntimeDispatcher
from agent.runtime.server.worker import RuntimeWorker


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    return RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))


@pytest.mark.asyncio
async def test_startup_queries_and_model_changes_do_not_create_files(worker, tmp_path, monkeypatch):
    messages = []

    async def send(payload):
        messages.append(payload)

    server = RuntimeDispatcher(worker, writer=SimpleNamespace(send=send))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", AsyncMock(
        return_value=SimpleNamespace(close=AsyncMock()),
    ))

    async def request(method, **params):
        await server.dispatch({"request_id": method, "method": method, "params": params})
        response = messages[-1]
        assert "error" not in response, response
        return response["result"]

    try:
        info = await request("initialize")
        session_id = info["session_id"]
        assert session_id and info["draft"] is True
        assert (await request("initialize"))["session_id"] == session_id
        assert (await request("session/switch", session_id=session_id))["draft"] is True
        await request("session/subscribe", session_id=session_id)
        await request("session/replay", session_id=session_id)
        await request("session/replay", session_id=session_id, after_cursor=0)
        await request("rind/context/inspect", session_id=session_id)
        assert (await request("rind/goal/get", session_id=session_id))["goal"] is None
        for command in ("/status", "/sessions", "/compact", "/team list"):
            await request("rind/command/execute", session_id=session_id, input=command)
        await request("model/set", session_id=session_id, provider_id="anthropic", model="chosen-model")
        await request("model/effort", session_id=session_id, reasoning_effort="high")
        selected = await worker.session(session_id)
        assert (selected["provider"], selected["model"], selected["reasoning_effort"]) == (
            "anthropic", "chosen-model", "high",
        )
        assert (await request("session/list"))["sessions"] == []
        assert worker.execution.active_session_ids() == set()
    finally:
        server.close()
        await worker.close()
    assert not (tmp_path / "sessions").exists()


@pytest.mark.asyncio
async def test_simultaneous_initialization_shares_one_draft(worker, tmp_path):
    try:
        results = await asyncio.gather(*(worker.initialize() for _ in range(8)))
        assert len({info["session_id"] for info in results}) == 1
        assert all(info["draft"] for info in results)
        assert not (tmp_path / "sessions").exists()
    finally:
        await worker.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["completed", "failed", "cancelled"])
async def test_first_turn_persists_before_model_and_remains_resumable(worker, tmp_path, monkeypatch, outcome):
    info = await worker.initialize()
    session_id = info["session_id"]
    base = tmp_path / "sessions" / session_id
    store = await worker.repository.open_store(session_id)
    await store.update_selection("openai-compatible", "chosen-model")
    await store.update_reasoning_effort("high")
    store_ref = weakref.ref(store)
    del store
    closed = AsyncMock()

    async def stream(*args, **kwargs):
        history = [json.loads(line) for line in (base / "messages.jsonl").read_text(encoding="utf-8").splitlines()]
        assert any(message["role"] == "user" and message["content"] == "first task" for message in history)
        if outcome == "failed":
            raise ProviderError("test failure", code="invalid_request", status="error")
        if outcome == "cancelled":
            raise asyncio.CancelledError()
        yield ModelStreamEvent(kind="text_delta", text="done")
        yield ModelStreamEvent(kind="completed", stop_reason="stop")

    factory = AsyncMock(return_value=SimpleNamespace(stream=stream, close=closed))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", factory)
    try:
        events = [event async for event in worker.execution.run_turn(session_id, query="first task")]
        assert events[-1]["type"] == f"turn_{outcome}"
        assert all(event["session_id"] == session_id for event in events)
        assert factory.call_args.args[1].model_id == "chosen-model"
        assert factory.call_args.args[1].reasoning_effort == "high"
        assert worker.execution.active_session_ids() == set()
        closed.assert_awaited_once()
        gc.collect()
        assert store_ref() is None
    finally:
        await worker.close()

    resumed = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"), resume_latest=True)
    try:
        restored = await resumed.initialize()
        assert restored["session_id"] == session_id and restored["draft"] is False
        assert restored["model"] == "chosen-model"
        assert restored["turn_state"]["status"] == outcome
        assert [entry["id"] for entry in await resumed.repository.list()] == [session_id]
        history = (await resumed.replay(session_id))["messages"]
        assert sum(message["role"] == "system" for message in history) == 1
        assert sum(message["role"] == "user" for message in history) == 1
    finally:
        await resumed.close()


@pytest.mark.asyncio
async def test_goal_materializes_draft_and_explicit_new_session_survives_restart(worker, tmp_path):
    try:
        startup = await worker.initialize()
        session_id = startup["session_id"]
        with pytest.raises(ValueError, match="Nothing to fork"):
            await worker.fork_session(session_id)
        goal = await worker.repository.set_goal(session_id, "finish the task")
        meta = JsonlSessionStore.load_session_metadata(session_id, str(tmp_path / "sessions"))
        assert meta["goal"] == goal
        created = await worker.create_session()
        assert created["draft"] is False
    finally:
        await worker.close()
    restored = RuntimeWorker(
        workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"), session_id=created["session_id"],
    )
    try:
        assert (await restored.initialize())["session_id"] == created["session_id"]
        assert (await restored.replay(created["session_id"]))["turn_state"] is None
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_named_draft_preserves_metadata_and_serializes_first_writes(tmp_path):
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="system")
    await store.create_session(session_id="reserved")
    catalog = [{"name": "test-skill", "description": "A skill", "scope": "user"}]
    await store.set_skill_catalog(catalog)
    await store.initialize()
    assert not Path(store.session_base_path).exists()
    await asyncio.gather(*(store.persist_message("user", f"task {i}") for i in range(4)))
    assert store.session_id == "reserved"
    assert await store.get_skill_catalog() == catalog
    messages = await store.load_messages()
    assert [message["role"] for message in messages] == ["system", "user", "user", "user", "user"]
    assert (await store.get_metadata())["message_count"] == 5
    with pytest.raises(ValueError, match="already exists"):
        await store.create_session(session_id="reserved")


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["rind/command/execute", "rind/session/compact"])
async def test_empty_compact_is_rejected_before_model_call(worker, tmp_path, monkeypatch, method):
    client = SimpleNamespace(create=AsyncMock(return_value=ModelCompletion(content="unexpected")), close=AsyncMock())
    monkeypatch.setattr(worker.provider_service, "create_chat_client", AsyncMock(return_value=client))
    writer = SimpleNamespace(send=AsyncMock())
    server = RuntimeDispatcher(worker, writer=writer)
    try:
        await server.dispatch({"request_id": "init", "method": "initialize", "params": {}})
        await server.dispatch({"request_id": "compact", "method": method, "params": {
            "session_id": worker.session_id, "input": "/compact",
        }})
        response = writer.send.call_args.args[0]
        assert "Not enough messages to compact" in json.dumps(response)
        client.create.assert_not_awaited()
        assert not (tmp_path / "sessions").exists()
        assert not worker.execution.active_session_ids()
    finally:
        server.close()
        await worker.close()


@pytest.mark.asyncio
async def test_execution_start_failure_can_retry_same_draft(worker, tmp_path, monkeypatch):
    session_id = (await worker.initialize())["session_id"]
    factory = AsyncMock(side_effect=RuntimeError("client initialization failed"))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", factory)
    try:
        with pytest.raises(RuntimeError, match="client initialization failed"):
            await worker.start_execution(session_id)
        assert not worker.execution.active_session_ids()
        assert not (tmp_path / "sessions").exists()
        assert (await worker.session(session_id))["draft"] is True

        async def stream(*args, **kwargs):
            yield ModelStreamEvent(kind="text_delta", text="recovered")
            yield ModelStreamEvent(kind="completed", stop_reason="stop")

        factory.side_effect = None
        factory.return_value = SimpleNamespace(stream=stream, close=AsyncMock())
        events = [event async for event in worker.execution.run_turn(session_id, query="retry")]
        assert events[-1]["type"] == "turn_completed"
        assert (await worker.session(session_id))["draft"] is False
        assert [path.name for path in (tmp_path / "sessions").iterdir() if path.is_dir()] == [session_id]
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_deleting_startup_draft_releases_it_without_files(worker, tmp_path):
    session_id = (await worker.initialize())["session_id"]
    store = await worker.repository.open_store(session_id)
    store_ref = weakref.ref(store)
    del store
    try:
        await worker.delete_session(session_id)
        gc.collect()
        assert store_ref() is None
        assert not (tmp_path / "sessions").exists()
        with pytest.raises(LookupError):
            await worker.session(session_id)
    finally:
        await worker.close()
