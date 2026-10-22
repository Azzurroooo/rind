"""Named connections: an endpoint and key the user adds with /login, kept in the
user's auth file. A selection names a connection; a missing one is reported,
never replaced by another endpoint."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.domain.errors import ProviderError
from agent.domain.models import ModelSelection
from agent.infrastructure.credentials import CredentialStore
from agent.infrastructure.llm.provider_service import ProviderServiceImpl
from agent.infrastructure.settings import AppSettings


class Answers:
    def __init__(self, *answers: str):
        self.answers = list(answers)
        self.prompts: list[tuple[str, str]] = []

    async def prompt(self, kind, message, options=None):
        self.prompts.append((kind, message))
        return self.answers.pop(0)


def _settings(tmp_path: Path) -> AppSettings:
    return AppSettings(tmp_path / "settings.json", False, "deepseek-flash", "", "", "", provider="deepseek")


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.load_settings", lambda: _settings(tmp_path))
    for name in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    instance = ProviderServiceImpl(CredentialStore(tmp_path / "auth.json"))
    monkeypatch.setattr(instance, "_fetch_models", AsyncMock(return_value=False))
    return instance


@pytest.mark.asyncio
async def test_a_named_connection_is_saved_to_providers_and_auth_and_offered_like_a_provider(service, tmp_path):
    answers = Answers(
        "Client A",
        "openai-responses · OpenAI Responses",
        "https://client-a.example/v1",
        "client-model",
        "client-key",
    )

    connection_id = await service.login("", "connection", answers)

    assert connection_id == "client-a"
    assert [kind for kind, _ in answers.prompts] == ["text", "select", "text", "text", "secret"], "only the key is masked"
    saved_auth = json.loads((tmp_path / "auth.json").read_text(encoding="utf-8"))["client-a"]
    assert saved_auth == {"type": "api_key", "key": "client-key"}
    saved_provider = json.loads((tmp_path / "providers.json").read_text(encoding="utf-8"))["providers"]["client-a"]
    assert saved_provider == {
        "name": "Client A",
        "api": "openai-responses",
        "baseUrl": "https://client-a.example/v1",
        "models": {"client-model": {}},
    }
    listed = {status.id: status for status in service.list_providers()}
    assert listed["client-a"].configured and listed["client-a"].source == "stored"
    models = [(model.provider_id, model.id, model.api) for model in (await service.list_models()).models]
    assert ("client-a", "client-model", "openai-responses") in models


@pytest.mark.asyncio
async def test_a_client_for_a_named_connection_uses_its_own_endpoint_protocol_and_key(service, tmp_path):
    await service.login("", "connection", Answers("Client A", "openai-chat", "https://client-a.example/v1", "m", "client-key"))

    client = await service.create_chat_client(_settings(tmp_path), ModelSelection("client-a", "m"))
    try:
        assert str(client._client.base_url).rstrip("/") == "https://client-a.example/v1"
        assert client._client.api_key == "client-key"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_logging_in_again_replaces_the_key_and_keeps_the_endpoint(service, tmp_path):
    await service.login("", "connection", Answers("Client A", "openai-chat", "https://client-a.example/v1", "", "old-key"))
    await service.login("client-a", "api_key", Answers("new-key"))

    saved_auth = json.loads((tmp_path / "auth.json").read_text(encoding="utf-8"))["client-a"]
    assert saved_auth["key"] == "new-key"
    saved_provider = json.loads((tmp_path / "providers.json").read_text(encoding="utf-8"))["providers"]["client-a"]
    assert saved_provider["baseUrl"] == "https://client-a.example/v1"


@pytest.mark.asyncio
async def test_logging_out_removes_the_stored_credential(service):
    await service.login("", "connection", Answers("Client A", "openai-chat", "https://client-a.example/v1", "m", "key"))

    assert service.logout("client-a") is True
    listed = {status.id: status for status in service.list_providers()}
    assert listed["client-a"].configured is False
    assert (await service.list_models()).models == []


@pytest.mark.asyncio
@pytest.mark.parametrize("answers, message", [
    (("deepseek",), "built-in provider"),
    (("!!!",), "letter or digit"),
    (("Client", ""), "canceled"),
    (("Client", "openai-chat", "ftp://x.example", "", "k"), "http(s) URL"),
    (("Client", "openai-chat", "https://x.example/v1", "", ""), "canceled"),
])
async def test_a_connection_needs_its_own_name_protocol_web_url_and_key(service, tmp_path, answers, message):
    with pytest.raises(ValueError, match=re.escape(message)):
        await service.login("", "connection", Answers(*answers))
    assert not (tmp_path / "auth.json").exists()
    assert not (tmp_path / "providers.json").exists()


@pytest.mark.asyncio
async def test_a_missing_connection_is_reported_not_replaced(service, tmp_path):
    with pytest.raises(ProviderError) as raised:
        await service.create_chat_client(_settings(tmp_path), ModelSelection("removed", "m"))

    assert raised.value.code == "connection_missing"
    assert "/login" in str(raised.value)


@pytest.mark.asyncio
async def test_a_turn_on_a_missing_connection_fails_with_the_reason(tmp_path, monkeypatch):
    from agent.runtime.server.worker import RuntimeWorker

    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    try:
        await worker.initialize()
        info = await worker.create_conversation({"provider_id": "removed", "model_id": "m"})
        events = [event async for event in worker.execution.run_turn(info["session_id"], query="hello")]
        failed = next(event for event in events if event.get("type") == "turn_failed")
        assert "Connection removed is not configured" in json.dumps(failed)
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_a_model_change_for_a_queued_turn_also_changes_image_support(tmp_path, monkeypatch):
    """The queued turn reuses the execution; its new model's image support goes with the new client."""
    from agent.domain.models import ModelStreamEvent
    from agent.runtime.server.worker import RuntimeWorker

    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "providers.json").write_text(json.dumps({
        "providers": {
            "deepseek": {
                "models": {
                    "deepseek-v4-pro": {"contextWindow": 1048576},
                    "deepseek-flash": {"contextWindow": 8192},
                }
            }
        }
    }), encoding="utf-8")
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    gate, waiting, seen = asyncio.Event(), asyncio.Event(), []

    async def create(settings, selection, *, workspace_root=None):
        session_provider = None

        def set_session_id_provider(provider):
            nonlocal session_provider
            session_provider = provider

        async def stream(*args, **kwargs):
            container = worker.execution.active_container(session_id)
            seen.append((selection.model_id, container.turn_runner.image_input,
                         container.context_manager.context_window, session_provider()))
            waiting.set()
            await gate.wait()
            yield ModelStreamEvent(kind="text_delta", text="ok")
            yield ModelStreamEvent(kind="completed", stop_reason="stop")

        return SimpleNamespace(stream=stream, close=AsyncMock(), set_session_id_provider=set_session_id_provider)

    monkeypatch.setattr(worker.provider_service, "create_chat_client", create)
    try:
        await worker.initialize()
        session_id = (await worker.create_conversation({"provider_id": "deepseek", "model_id": "deepseek-v4-pro"}))["session_id"]
        first = asyncio.create_task(_drain(worker.execution.run_turn(session_id, query="first")))
        await waiting.wait()
        second = asyncio.create_task(_drain(worker.execution.run_turn(session_id, query="second")))
        await asyncio.sleep(0)
        await worker.execution.active_container(session_id).session_store.update_selection("deepseek", "deepseek-flash")
        gate.set()
        await first
        await second
        assert seen == [("deepseek-v4-pro", False, 1048576, session_id), ("deepseek-flash", True, 8192, session_id)]
    finally:
        await worker.close()


async def _drain(events):
    return [event async for event in events]



@pytest.mark.asyncio
async def test_status_describes_whether_a_connection_is_built_in_custom_or_overridden_and_how_it_signs_in(service, tmp_path, monkeypatch):
    assert service.describe_connection("removed") is None

    # Built-ins read no environment variable unless providers.json names one; that alone keeps the endpoint built-in.
    (tmp_path / "providers.json").write_text(json.dumps({"providers": {"deepseek": {"envKey": "DEEPSEEK_API_KEY"}}}), encoding="utf-8")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "env-key")
    builtin = service.describe_connection("deepseek", "deepseek-flash")
    assert builtin == {
        "name": "DeepSeek", "endpoint": "https://api.deepseek.com/v1", "api": "openai-chat", "kind": "builtin",
        "auth": "api_key", "credential": "environment", "env_key": "DEEPSEEK_API_KEY", "account": "",
    }
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    assert (service.describe_connection("deepseek")["auth"], service.describe_connection("deepseek")["credential"]) == ("none", "none")

    await service.login("", "connection", Answers("Client A", "openai-responses", "https://client-a.example/v1", "m", "client-key"))
    custom = service.describe_connection("client-a")
    assert (custom["kind"], custom["api"], custom["auth"], custom["credential"]) == ("custom", "openai-responses", "api_key", "stored")

    (tmp_path / "providers.json").write_text(json.dumps({"providers": {"deepseek": {"baseUrl": "https://proxy.example/v1"}}}), encoding="utf-8")
    overridden = service.describe_connection("deepseek")
    assert (overridden["kind"], overridden["endpoint"]) == ("overridden", "https://proxy.example/v1")


def test_status_names_the_account_behind_an_oauth_sign_in(service):
    from agent.domain.models import Credential

    service.credentials.set("openai", Credential(type="oauth", access="a", refresh="r", expires_at=1, client_id="c"))
    described = service.describe_connection("openai", "gpt-5.5")
    assert (described["auth"], described["credential"], described["account"], described["api"]) == ("oauth", "stored", "ChatGPT", "openai-responses")
