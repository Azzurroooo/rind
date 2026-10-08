"""A conversation exists only after its first message: opening a window creates nothing."""

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


def _server(worker):
    messages = []

    async def send(payload):
        messages.append(payload)

    server = RuntimeDispatcher(worker, writer=SimpleNamespace(send=send))

    async def request(method, expect_error=False, **params):
        await server.dispatch({"request_id": method, "method": method, "params": params})
        response = next(message for message in reversed(messages) if message.get("request_id") == method)
        assert ("error" in response) == expect_error, response
        return response.get("error") if expect_error else response["result"]

    return server, request, messages


def _stream(text="done"):
    async def stream(*args, **kwargs):
        yield ModelStreamEvent(kind="text_delta", text=text)
        yield ModelStreamEvent(kind="completed", stop_reason="stop")

    return stream


@pytest.mark.asyncio
async def test_opening_a_window_creates_no_conversation(worker, tmp_path):
    server, request, _ = _server(worker)
    try:
        info = await request("initialize")
        assert info["session_id"] == "" and "draft" not in info
        assert info["model"] and info["provider"] and info["workspace_root"]
        assert (await request("initialize"))["session_id"] == ""
        listing = await request("rind/command/execute", input="/sessions")
        assert listing["display"]["sessions"] == [], "listing needs no conversation"
        other = await request("rind/command/execute", input="/compact")
        assert "first message" in json.dumps(other), "commands that need a conversation say how to start one"
        assert (await request("session/list"))["sessions"] == []
        assert worker.repository.draft_store("x") is None
    finally:
        server.close()
        await worker.close()
    assert not (tmp_path / "sessions").exists()


@pytest.mark.asyncio
async def test_simultaneous_initialization_creates_nothing(worker, tmp_path):
    try:
        results = await asyncio.gather(*(worker.initialize() for _ in range(8)))
        assert {info["session_id"] for info in results} == {""}
        assert not (tmp_path / "sessions").exists()
    finally:
        await worker.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["completed", "failed", "cancelled"])
async def test_first_message_creates_and_saves_the_conversation(worker, tmp_path, monkeypatch, outcome):
    await worker.initialize()
    info = await worker.create_conversation({"workspace_root": str(tmp_path), "provider_id": "openai-compatible", "model_id": "chosen-model", "reasoning_effort": "high"})
    session_id = info["session_id"]
    assert session_id and (info["model"], info["reasoning_effort"]) == ("chosen-model", "high")
    assert not (tmp_path / "sessions").exists(), "created on submit, saved by the message itself"
    base = tmp_path / "sessions" / session_id
    store_ref = weakref.ref(await worker.repository.open_store(session_id))
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
        assert restored["session_id"] == session_id
        assert restored["model"] == "chosen-model"
        assert restored["turn_state"]["status"] == outcome
        assert [entry["id"] for entry in await resumed.repository.list()] == [session_id]
        history = (await resumed.replay(session_id))["messages"]
        assert sum(message["role"] == "system" for message in history) == 1
        assert sum(message["role"] == "user" for message in history) == 1
    finally:
        await resumed.close()


@pytest.mark.asyncio
async def test_a_first_prompt_that_fails_before_saving_leaves_nothing(worker, tmp_path, monkeypatch):
    factory = AsyncMock(side_effect=RuntimeError("client initialization failed"))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", factory)
    server, request, messages = _server(worker)
    try:
        await request("initialize")
        session_id = (await request("session/create", workspace_root=str(tmp_path)))["session_id"]
        error = await request("session/prompt", expect_error=True, session_id=session_id, input="hello")
        assert "client initialization failed" in json.dumps(error)
        discarded = [m for m in messages if m.get("event", {}).get("type") == "session_discarded"]
        assert [m["event"]["session_id"] for m in discarded] == [session_id], "every observer learns it is gone"
        with pytest.raises(LookupError):
            await worker.session(session_id)
        assert not (tmp_path / "sessions").exists()

        factory.side_effect = None
        factory.return_value = SimpleNamespace(stream=_stream("recovered"), close=AsyncMock())
        retry = (await request("session/create", workspace_root=str(tmp_path)))["session_id"]
        await request("session/prompt", session_id=retry, input="retry")
        assert [path.name for path in (tmp_path / "sessions").iterdir() if path.is_dir()] == [retry]
        assert len([m for m in messages if m.get("event", {}).get("type") == "session_discarded"]) == 1
    finally:
        server.close()
        await worker.close()


@pytest.mark.asyncio
async def test_a_conversation_created_but_never_prompted_is_discarded_later(worker, tmp_path):
    clock = [1000.0]
    worker.repository.now = lambda: clock[0]
    try:
        abandoned = (await worker.create_conversation({"workspace_root": str(tmp_path)}))["session_id"]
        clock[0] += 30
        kept = (await worker.create_conversation({"workspace_root": str(tmp_path)}))["session_id"]
        assert worker.repository.draft_store(abandoned) is not None, "still within its first-message window"
        clock[0] += 61
        await worker.create_conversation({"workspace_root": str(tmp_path)})
        assert worker.repository.draft_store(abandoned) is None
        assert worker.repository.draft_store(kept) is None
        assert not (tmp_path / "sessions").exists()
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_goal_saves_a_created_conversation_and_fork_needs_a_message(worker, tmp_path):
    try:
        session_id = (await worker.create_conversation({"workspace_root": str(tmp_path)}))["session_id"]
        with pytest.raises(ValueError, match="Nothing to fork"):
            await worker.fork_session(session_id)
        goal = await worker.repository.set_goal(session_id, "finish the task")
        meta = JsonlSessionStore.load_session_metadata(session_id, str(tmp_path / "sessions"))
        assert meta["goal"] == goal
    finally:
        await worker.close()


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
        session_id = (await worker.create_conversation({"workspace_root": str(tmp_path)}))["session_id"]
        await server.dispatch({"request_id": "compact", "method": method, "params": {"session_id": session_id, "input": "/compact"}})
        response = writer.send.call_args.args[0]
        assert "Not enough messages to compact" in json.dumps(response)
        client.create.assert_not_awaited()
        assert not (tmp_path / "sessions").exists()
        assert not worker.execution.active_session_ids()
    finally:
        server.close()
        await worker.close()


@pytest.mark.asyncio
async def test_deleting_an_unsaved_conversation_releases_it_without_files(worker, tmp_path):
    session_id = (await worker.create_conversation({"workspace_root": str(tmp_path)}))["session_id"]
    store_ref = weakref.ref(await worker.repository.open_store(session_id))
    try:
        await worker.delete_session(session_id)
        gc.collect()
        assert store_ref() is None
        assert not (tmp_path / "sessions").exists()
        with pytest.raises(LookupError):
            await worker.session(session_id)
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_a_window_retries_its_first_message_under_the_same_identity(worker, tmp_path, monkeypatch):
    factory = AsyncMock(side_effect=RuntimeError("no key"))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", factory)
    server, request, _ = _server(worker)
    try:
        await request("initialize")
        first = (await request("session/create", workspace_root=str(tmp_path)))["session_id"]
        await request("session/prompt", expect_error=True, session_id=first, input="hello")
        factory.side_effect = None
        factory.return_value = SimpleNamespace(stream=_stream(), close=AsyncMock())
        again = (await request("session/create", workspace_root=str(tmp_path), session_id=first))["session_id"]
        assert again == first, "a team window stays bound to one conversation"
        await request("session/prompt", session_id=first, input="hello")
        error = await request("session/create", expect_error=True, workspace_root=str(tmp_path), session_id=first)
        assert "already exists" in json.dumps(error), "a saved conversation is never taken over"
    finally:
        server.close()
        await worker.close()


@pytest.mark.asyncio
async def test_before_the_first_message_an_unknown_command_is_reported_as_unknown(worker, tmp_path):
    _, request, _ = _server(worker)
    try:
        await request("initialize")
        unknown = await request("rind/command/execute", input="/nosuchcommand")
        assert "Unknown command: /nosuchcommand" in unknown["text"]
        assert "needs a conversation" not in unknown["text"]
        known = await request("rind/command/execute", input="/compact")
        assert "/compact needs a conversation" in known["text"]
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_status_before_the_first_message_reports_what_the_window_chose(worker, tmp_path):
    _, request, _ = _server(worker)
    try:
        await request("initialize")
        draft = {"name": "Spike", "provider": "longcat", "model": "longcat-flash", "reasoning_effort": "low"}
        result = await request("rind/command/execute", input="/status", draft=draft)
        entries = {entry["label"]: entry["value"] for entry in result["display"]["entries"]}
        assert entries["name"] == "Spike · applies when the conversation starts"
        assert entries["model"] == "longcat-flash · this conversation", "the window chose it, not a default"
        assert entries["connection"] == "longcat · LongCat", "built-in connections are named even before a login"
        # A draft that is not a mapping is ignored rather than trusted.
        plain = await request("rind/command/execute", input="/status", draft="nonsense")
        assert {entry["label"]: entry["value"] for entry in plain["display"]["entries"]}["name"] == "unset · shown by its first message"
    finally:
        await worker.close()
