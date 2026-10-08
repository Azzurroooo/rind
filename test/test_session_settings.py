"""A conversation's provider, model and effort: changes apply from the next turn,
are announced to every window, and are listed with the conversation."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.domain.models import ModelStreamEvent
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

    async def request(method, **params):
        await server.dispatch({"request_id": method, "method": method, "params": params})
        response = next(message for message in reversed(messages) if message.get("request_id") == method)
        assert "error" not in response, response
        return response["result"]

    return server, request, messages


class Recorder:
    """Chat clients that remember which model each sampling used."""

    def __init__(self):
        self.samplings: list[str] = []
        self.created: list[tuple[str, str, str]] = []
        self.gate: asyncio.Event | None = None
        self.waiting = asyncio.Event()

    async def create(self, settings, selection, *, workspace_root=None):
        self.created.append((selection.provider_id, selection.model_id, selection.reasoning_effort))
        model = selection.model_id

        async def stream(*args, **kwargs):
            self.samplings.append(model)
            if self.gate is not None:
                self.waiting.set()
                await self.gate.wait()
            yield ModelStreamEvent(kind="text_delta", text="done")
            yield ModelStreamEvent(kind="completed", stop_reason="stop")

        return SimpleNamespace(stream=stream, close=AsyncMock())


async def _conversation(worker, tmp_path, request=None, model="model-a"):
    if request is not None:
        await request("initialize")
    else:
        await worker.initialize()
    info = await worker.create_conversation({"workspace_root": str(tmp_path), "provider_id": "openai-compatible", "model_id": model, "reasoning_effort": "low"})
    return info["session_id"]


async def _turn(worker, session_id, query):
    return [event async for event in worker.execution.run_turn(session_id, query=query)]


@pytest.mark.asyncio
async def test_a_change_during_a_turn_applies_from_the_next_turn(worker, tmp_path, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(worker.provider_service, "create_chat_client", recorder.create)
    _, request, _ = _server(worker)
    try:
        session_id = await _conversation(worker, tmp_path, request)
        recorder.gate = asyncio.Event()
        running = asyncio.create_task(_turn(worker, session_id, "first"))
        await recorder.waiting.wait()
        changed = await request("model/set", session_id=session_id, provider_id="openai-compatible", model_id="model-b")
        assert changed["applies"] == "next_turn", "a turn is running, so the change waits for the next one"
        recorder.gate.set()
        await running
        recorder.gate = None
        await _turn(worker, session_id, "second")
        assert recorder.samplings == ["model-a", "model-b"]
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_queued_turns_use_the_new_model_without_waiting_for_the_queue_to_drain(worker, tmp_path, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(worker.provider_service, "create_chat_client", recorder.create)
    _, request, _ = _server(worker)
    try:
        session_id = await _conversation(worker, tmp_path, request)
        recorder.gate = asyncio.Event()
        first = asyncio.create_task(_turn(worker, session_id, "first"))
        await recorder.waiting.wait()
        # Queued behind the running turn: the execution is never released in between.
        second = asyncio.create_task(_turn(worker, session_id, "second"))
        await asyncio.sleep(0)
        await request("model/effort", session_id=session_id, reasoning_effort="high")
        await request("model/set", session_id=session_id, provider_id="openai-compatible", model_id="model-b")
        recorder.gate.set()
        await first
        await second
        assert recorder.samplings == ["model-a", "model-b"]
        assert recorder.created[-1] == ("openai-compatible", "model-b", "high")
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_an_unchanged_selection_keeps_the_same_client(worker, tmp_path, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(worker.provider_service, "create_chat_client", recorder.create)
    try:
        session_id = await _conversation(worker, tmp_path)
        recorder.gate = asyncio.Event()
        first = asyncio.create_task(_turn(worker, session_id, "first"))
        await recorder.waiting.wait()
        second = asyncio.create_task(_turn(worker, session_id, "second"))
        await asyncio.sleep(0)
        recorder.gate.set()
        await first
        await second
        assert len(recorder.created) == 1
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_an_idle_change_applies_now_and_every_window_hears_it(worker, tmp_path, monkeypatch):
    monkeypatch.setattr(worker.provider_service, "create_chat_client", Recorder().create)
    _, request, messages = _server(worker)
    try:
        session_id = await _conversation(worker, tmp_path, request)
        await request("session/subscribe", session_id=session_id)
        changed = await request("model/set", session_id=session_id, provider_id="openai-compatible", model_id="model-b")
        assert changed["applies"] == "now"
        await request("model/effort", session_id=session_id, reasoning_effort="high")
        events = [m["event"] for m in messages if m.get("event", {}).get("type") == "session_settings_changed"]
        assert [(e["model"], e["reasoning_effort"]) for e in events] == [("model-b", "low"), ("model-b", "high")]
        assert all(e["session_id"] == session_id and e["provider"] == "openai-compatible" for e in events)
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_the_session_list_carries_each_conversation_settings(worker, tmp_path, monkeypatch):
    monkeypatch.setattr(worker.provider_service, "create_chat_client", Recorder().create)
    _, request, _ = _server(worker)
    try:
        session_id = await _conversation(worker, tmp_path, request)
        await _turn(worker, session_id, "first")
        await request("model/set", session_id=session_id, provider_id="openai-compatible", model_id="model-b")
        await request("model/effort", session_id=session_id, reasoning_effort="high")
        listed = next(entry for entry in (await request("session/list", workspace_root=str(tmp_path)))["sessions"] if entry["id"] == session_id)
        assert (listed["provider"], listed["model"], listed["reasoning_effort"]) == ("openai-compatible", "model-b", "high")
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_a_new_window_learns_enough_to_greet_and_a_resumed_one_to_say_what_it_resumes(worker, tmp_path, monkeypatch):
    monkeypatch.setattr(worker.provider_service, "create_chat_client", Recorder().create)
    _, request, _ = _server(worker)
    try:
        blank = await request("initialize")
        assert blank["session_id"] == ""
        assert blank["has_rind_doc"] is False
        session_id = await _conversation(worker, tmp_path, request)
        await _turn(worker, session_id, "fix the login page")
        (tmp_path / "RIND.md").write_text("# notes", encoding="utf-8")
        again = await worker.repository.blank(str(tmp_path))
        assert again["has_rind_doc"] is True
        resumed = await worker.session(session_id)
        assert resumed["title"] == "fix the login page"
        assert resumed["updated_at"]
    finally:
        await worker.close()
