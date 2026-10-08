"""Folder defaults through the runtime: set, read, unset, used by new
conversations, shown by /status, and applied to a reopened conversation."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent.domain.models import Credential
from agent.runtime.server.dispatcher import RuntimeDispatcher
from agent.runtime.server.worker import RuntimeWorker


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    for name in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    instance = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    instance.provider_service.credentials.set("deepseek", Credential(type="api_key", key="k"))
    return instance


def _server(worker):
    messages = []

    async def send(payload):
        messages.append(payload)

    server = RuntimeDispatcher(worker, writer=SimpleNamespace(send=send))

    async def call(method, **params):
        await server.dispatch({"request_id": method, "method": method, "params": params})
        return next(message for message in reversed(messages) if message.get("request_id") == method)

    async def request(method, **params):
        response = await call(method, **params)
        assert "error" not in response, response
        return response["result"]

    return request, call, messages


def _entries(result):
    return {entry["label"]: entry["value"] for entry in result["display"]["entries"]}


@pytest.mark.asyncio
async def test_a_new_conversation_starts_with_its_folder_defaults_and_says_so(worker, tmp_path):
    request, _, _ = _server(worker)
    try:
        await request("initialize")
        set_result = await request("rind/folder_defaults/set", workspace_root=str(tmp_path),
                                   provider_id="deepseek", model_id="deepseek-flash", reasoning_effort="high")
        assert set_result["resolved"] == {"provider": "deepseek", "model": "deepseek-flash", "reasoning_effort": "high",
                                               "model_source": "folder", "effort_source": "folder"}
        blank = await request("initialize")
        assert (blank["provider"], blank["model"], blank["reasoning_effort"]) == ("deepseek", "deepseek-flash", "high")

        session_id = (await request("session/create"))["session_id"]
        status = _entries(await request("rind/command/execute", session_id=session_id, input="/status"))
        assert status["model"] == "deepseek-flash · folder default"
        assert status["reasoningEffort"] == "high · folder default"
        assert status["connection"] == "deepseek · DeepSeek" and status["key"] == "stored login"

        await request("model/effort", session_id=session_id, reasoning_effort="low")
        status = _entries(await request("rind/command/execute", session_id=session_id, input="/status"))
        assert status["reasoningEffort"] == "low · this conversation"
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_changing_a_folder_default_leaves_existing_conversations_alone(worker, tmp_path):
    request, _, _ = _server(worker)
    try:
        await request("initialize")
        await request("rind/folder_defaults/set", workspace_root=str(tmp_path), provider_id="deepseek", model_id="deepseek-flash")
        session_id = (await request("session/create"))["session_id"]
        await request("rind/folder_defaults/set", workspace_root=str(tmp_path), provider_id="deepseek", model_id="deepseek-v4-pro")
        assert (await worker.session(session_id))["model"] == "deepseek-flash"
        assert (await request("session/create"))["model"] == "deepseek-v4-pro"
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_a_reopened_conversation_can_be_brought_to_the_folder_defaults(worker, tmp_path):
    request, _, messages = _server(worker)
    try:
        await request("initialize")
        session_id = (await request("session/create"))["session_id"]
        await request("session/subscribe", session_id=session_id)
        await request("rind/folder_defaults/set", workspace_root=str(tmp_path),
                      provider_id="deepseek", model_id="deepseek-flash", reasoning_effort="max")

        applied = await request("rind/folder_defaults/apply", session_id=session_id)
        assert applied["changed"] is True and applied["applies"] == "now"
        assert (applied["model_id"], applied["reasoning_effort"]) == ("deepseek-flash", "max")
        changed = next(m["event"] for m in messages if m.get("event", {}).get("type") == "session_settings_changed")
        assert changed["selection_source"] == {"model": "folder", "effort": "folder"}
        assert changed["connection_ready"] is True
        status = _entries(await request("rind/command/execute", session_id=session_id, input="/status"))
        assert status["model"] == "deepseek-flash · folder default"
        assert (await request("rind/folder_defaults/apply", session_id=session_id))["changed"] is False
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_only_a_runnable_model_and_a_supported_effort_can_become_a_default(worker, tmp_path):
    request, call, _ = _server(worker)
    try:
        await request("initialize")
        unknown = await call("rind/folder_defaults/set", workspace_root=str(tmp_path), provider_id="openai", model_id="gpt-5.5")
        assert "not available" in unknown["error"]["message"] and "/login" in unknown["error"]["message"]
        unsupported = await call("rind/folder_defaults/set", workspace_root=str(tmp_path),
                                 provider_id="deepseek", model_id="deepseek-flash", reasoning_effort="medium")
        assert "supports reasoning effort low, high, max" in unsupported["error"]["message"]
        half = await call("rind/folder_defaults/set", workspace_root=str(tmp_path), model_id="deepseek-flash")
        assert half["error"]["type"] == "ValueError"
        assert (await request("rind/folder_defaults/get", workspace_root=str(tmp_path)))["folder"] == {}
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_unsetting_a_folder_default_falls_back_to_settings(worker, tmp_path):
    request, _, _ = _server(worker)
    try:
        await request("initialize")
        await request("rind/folder_defaults/set", workspace_root=str(tmp_path),
                      provider_id="deepseek", model_id="deepseek-flash", reasoning_effort="high")
        set_both = await request("rind/folder_defaults/get", workspace_root=str(tmp_path))
        assert set_both["inherited"]["model_source"] == "settings", "what clearing would fall back to"
        assert set_both["inherited"]["effort_source"] == "settings"
        result = await request("rind/folder_defaults/unset", workspace_root=str(tmp_path), group="model")
        assert result["folder"] == {"reasoning_effort": "high"}
        assert result["resolved"]["model_source"] == "settings"
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_many_folders_resolve_at_once_and_a_change_is_announced(worker, tmp_path):
    request, call, messages = _server(worker)
    other = tmp_path / "other"
    other.mkdir()
    try:
        await request("initialize")
        await request("rind/folder_defaults/set", workspace_root=str(tmp_path), provider_id="deepseek", model_id="deepseek-flash")
        announced = [m["event"] for m in messages if m.get("event", {}).get("type") == "folder_defaults_changed"]
        assert len(announced) == 1 and "session_id" not in announced[0], "for every observer, not one conversation"
        folders = (await request("rind/folder_defaults/resolve", workspace_roots=[str(tmp_path), str(other), str(tmp_path / "gone")]))["folders"]
        assert set(folders) == {str(tmp_path), str(other)}, "keyed as asked; a missing folder is left out"
        assert (folders[str(tmp_path)]["model"], folders[str(tmp_path)]["model_source"], folders[str(tmp_path)]["connection_ready"]) == ("deepseek-flash", "folder", True)
        assert folders[str(other)]["model_source"] == "settings"
        bad = await call("rind/folder_defaults/resolve", workspace_roots="nope")
        assert bad["error"]["type"] == "ValueError"
    finally:
        await worker.close()
