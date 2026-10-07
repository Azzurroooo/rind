"""A conversation shows its name when it has one, otherwise its first message."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.domain.models import ModelStreamEvent
from agent.infrastructure.persistence import JsonlSessionStore, fork_session
from agent.infrastructure.persistence.session_meta import display_title, normalize_name
from agent.runtime.server.dispatcher import RuntimeDispatcher
from agent.runtime.server.worker import RuntimeWorker


def test_display_title_prefers_the_name_then_the_first_message():
    assert display_title({"name": "Release checks", "title": "run the tests"}) == "Release checks"
    assert display_title({"title": "run the tests"}) == "run the tests"
    assert display_title({"title": "Untitled"}) == "", "the old placeholder means no title"
    assert display_title({}) == ""


def test_names_are_one_clean_line_of_bounded_length():
    assert normalize_name("  Release\n\tchecks  ") == "Release checks"
    assert normalize_name("a\x1b[31mb\x07c") == "a[31mbc"
    assert normalize_name("x" * 200) == "x" * 80
    for empty in ("", "   ", "\n\x00"):
        with pytest.raises(ValueError, match="empty"):
            normalize_name(empty)


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))

    async def stream(*args, **kwargs):
        yield ModelStreamEvent(kind="text_delta", text="done")
        yield ModelStreamEvent(kind="completed", stop_reason="stop")

    instance = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    monkeypatch.setattr(instance.provider_service, "create_chat_client", AsyncMock(return_value=SimpleNamespace(stream=stream, close=AsyncMock())))
    return instance


def _server(worker):
    messages = []

    async def send(payload):
        messages.append(payload)

    server = RuntimeDispatcher(worker, writer=SimpleNamespace(send=send))

    async def request(method, **params):
        await server.dispatch({"request_id": method, "method": method, "params": params})
        response = next(m for m in reversed(messages) if m.get("request_id") == method)
        assert "error" not in response, response
        return response["result"]

    return server, request, messages


def _listed(tmp_path):
    return {entry["id"]: entry for entry in JsonlSessionStore.list_session_metadata(str(tmp_path / "sessions"))}


@pytest.mark.asyncio
async def test_rename_shows_resets_and_is_listed_everywhere(worker, tmp_path):
    server, request, messages = _server(worker)
    try:
        await request("initialize")
        session_id = (await request("session/create", workspace_root=str(tmp_path)))["session_id"]
        await request("session/prompt", session_id=session_id, input="please run the full regression suite before release")
        entry = _listed(tmp_path)[session_id]
        assert entry["title"] == "please run the full regression suite before release"
        assert entry.get("name") is None

        shown = await request("rind/command/execute", session_id=session_id, input="/rename")
        assert "/rename <name>" in shown["text"] and "please run" in shown["text"], "no argument changes nothing"
        assert _listed(tmp_path)[session_id].get("name") is None

        apostrophe = await request("rind/command/execute", session_id=session_id, input="/rename Bob's notes")
        assert apostrophe["display"]["name"] == "Bob's notes", "the name is taken as typed"
        renamed = await request("rind/command/execute", session_id=session_id, input="/rename  Release   checks ")
        assert renamed["display"] == {"type": "session_renamed", "session_id": session_id, "name": "Release checks", "title": "Release checks"}
        entry = _listed(tmp_path)[session_id]
        assert (entry["title"], entry["name"]) == ("Release checks", "Release checks")
        events = [m["event"] for m in messages if m.get("event", {}).get("type") == "session_renamed"]
        assert events[-1] == {"type": "session_renamed", "session_id": session_id, "turn_id": "", "name": "Release checks", "title": "Release checks"}

        await request("rind/command/execute", session_id=session_id, input="/rename --reset")
        entry = _listed(tmp_path)[session_id]
        assert entry["title"].startswith("please run") and entry.get("name") is None
        meta = JsonlSessionStore.load_session_metadata(session_id, str(tmp_path / "sessions"))
        assert "name" not in meta
    finally:
        server.close()
        await worker.close()


@pytest.mark.asyncio
async def test_a_name_chosen_before_the_first_message_is_kept(worker, tmp_path):
    server, request, _ = _server(worker)
    try:
        await request("initialize")
        refused = await request("rind/command/execute", input="/rename Early")
        assert "first message" in json.dumps(refused), "the window keeps a pending name; the worker has no conversation yet"
        session_id = (await request("session/create", workspace_root=str(tmp_path), name="  Early  name "))["session_id"]
        await request("session/prompt", session_id=session_id, input="hello")
        assert _listed(tmp_path)[session_id]["title"] == "Early name"
    finally:
        server.close()
        await worker.close()


@pytest.mark.asyncio
async def test_a_fork_is_not_given_the_same_name(tmp_path):
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path), system_prompt="system")
    await store.initialize()
    await store.persist_message("user", "first message")
    await store.set_name("Release checks")
    forked = fork_session(str(tmp_path / "sessions"), store.session_id)
    meta = JsonlSessionStore.load_session_metadata(forked, str(tmp_path / "sessions"))
    assert "name" not in meta
    assert meta["title"] == "Release checks (fork)", "the fork is told apart from its source"
