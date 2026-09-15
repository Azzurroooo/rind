from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.domain.models import Credential, ModelSelection
from agent.infrastructure.auth import CredentialStore
from agent.infrastructure.config.settings_loader import AppSettings
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.llm.provider_service import ProviderServiceImpl


def test_credential_list_redacts_secret(tmp_path: Path) -> None:
    store = CredentialStore(tmp_path / "auth.json")
    store.set("deepseek", Credential(type="api_key", key="test-secret"))

    assert store.list() == [{"provider_id": "deepseek", "type": "api_key"}]
    assert store.get("deepseek").key == "test-secret"


def test_provider_service_resolves_legacy_settings_to_compatible_provider(tmp_path: Path, monkeypatch) -> None:
    settings_path = tmp_path / "settings.json"
    settings = AppSettings(settings_path, True, "deepseek-flash", "test-key", "https://api.deepseek.com", "high")
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.load_settings", lambda _root=None: settings)

    service = ProviderServiceImpl(CredentialStore(tmp_path / "auth.json"))

    assert service.default_selection(str(tmp_path)) == ModelSelection("openai-compatible", "deepseek-flash", "high")


@pytest.mark.asyncio
async def test_openai_chat_adapter_reuses_call_id_for_argument_deltas() -> None:
    chunks = [
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None, reasoning_content=None, tool_calls=[SimpleNamespace(index=0, id="call_1", function=SimpleNamespace(name="bash", arguments=""))]), finish_reason=None)], usage=None),
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None, reasoning_content=None, tool_calls=[SimpleNamespace(index=0, id=None, function=SimpleNamespace(name=None, arguments='{"command":"pwd"}'))]), finish_reason=None)], usage=None),
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None, reasoning_content=None, tool_calls=None), finish_reason="tool_calls")], usage=None),
    ]

    class Provider:
        class chat:
            class completions:
                @staticmethod
                async def create(**_kwargs):
                    async def stream():
                        for chunk in chunks:
                            yield chunk
                    return stream()

    client = OpenAIChatCompletionsClient(Provider(), "deepseek-flash")
    events = [event async for event in client.stream([], [{"name": "bash"}])]

    assert [event.kind for event in events] == ["tool_start", "tool_arguments_delta", "completed"]
    assert events[1].tool_call_id == "call_1"
