from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.domain.errors import ProviderError
from agent.domain.models import Credential, ModelSelection
from agent.infrastructure.auth import CredentialStore
from agent.infrastructure.config.settings_loader import AppSettings
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.llm.openai_chat_client import build_async_client
from agent.infrastructure.llm.provider_service import ProviderServiceImpl


def _settings(tmp_path: Path, **overrides) -> AppSettings:
    values = {
        "settings_path": tmp_path / "settings.json",
        "settings_exists": True,
        "model": "deepseek-chat",
        "api_key": "",
        "base_url": "",
        "reasoning_effort": "",
        "provider": "deepseek",
    }
    values.update(overrides)
    return AppSettings(**values)


def _service(tmp_path: Path, settings: AppSettings, monkeypatch) -> ProviderServiceImpl:
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.load_settings", lambda _root=None: settings)
    return ProviderServiceImpl(CredentialStore(tmp_path / "auth.json"))


class _PromptInteraction:
    def __init__(self, answer: str):
        self.answer = answer
        self.prompts: list[tuple] = []

    async def prompt(self, kind, message, options=None):
        self.prompts.append((kind, message))
        return self.answer

    def notify(self, event):
        pass


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


def test_credential_resolution_prefers_workspace_then_stored_then_environment(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)

    assert service._credential_source(settings, "deepseek") == "none"
    assert service._resolve_credential(settings, "deepseek") is None

    monkeypatch.setenv("DEEPSEEK_API_KEY", "env-key")
    assert service._credential_source(settings, "deepseek") == "environment"
    assert service._resolve_credential(settings, "deepseek").key == "env-key"

    service.credentials.set("deepseek", Credential(type="api_key", key="stored-key"))
    assert service._credential_source(settings, "deepseek") == "stored"
    assert service._resolve_credential(settings, "deepseek").key == "stored-key"

    workspace = _settings(tmp_path, api_key="workspace-key")
    assert service._credential_source(workspace, "deepseek") == "workspace"
    assert service._resolve_credential(workspace, "deepseek").key == "workspace-key"

    env_settings = _settings(tmp_path, api_key="$DEEPSEEK_API_KEY")
    assert service._resolve_credential(env_settings, "deepseek").key == "env-key"


def test_model_refresh_endpoint_stays_per_provider(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path, provider="openai-compatible", api_key="local", base_url="http://127.0.0.1:9/v1")
    service = _service(tmp_path, settings, monkeypatch)

    deepseek = service._provider("deepseek")
    assert service._endpoint(settings, deepseek) == deepseek.default_base_url
    assert service._endpoint(settings, service._provider("openai-compatible")) == "http://127.0.0.1:9/v1"

    custom = _settings(tmp_path, provider="deepseek", base_url="https://proxy.deepseek.example/v1")
    assert service._endpoint(custom, deepseek) == "https://proxy.deepseek.example/v1"


@pytest.mark.asyncio
async def test_login_saves_key_and_refreshes_only_that_provider(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)
    refreshed: list[str] = []

    async def _fetch(settings, definition):
        refreshed.append(definition.id)
        return True

    monkeypatch.setattr(service, "_fetch_models", _fetch)
    interaction = _PromptInteraction("secret-key")

    await service.login(str(tmp_path), "deepseek", "api_key", interaction)

    assert interaction.prompts == [("secret", "DeepSeek API key")]
    assert service.credentials.get("deepseek").key == "secret-key"
    assert refreshed == ["deepseek"]


@pytest.mark.asyncio
async def test_login_with_empty_key_cancels(tmp_path: Path, monkeypatch) -> None:
    service = _service(tmp_path, _settings(tmp_path), monkeypatch)

    with pytest.raises(ValueError, match="canceled"):
        await service.login(str(tmp_path), "deepseek", "api_key", _PromptInteraction("  "))

    assert service.credentials.get("deepseek") is None


@pytest.mark.asyncio
async def test_login_rejects_unsupported_method(tmp_path: Path, monkeypatch) -> None:
    service = _service(tmp_path, _settings(tmp_path), monkeypatch)

    with pytest.raises(ValueError, match="does not support"):
        await service.login(str(tmp_path), "deepseek", "oauth", _PromptInteraction("token"))


@pytest.mark.asyncio
async def test_list_models_uses_cache_fallback_and_reports_refresh_warning(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)
    service.credentials.set("deepseek", Credential(type="api_key", key="deepseek-key"))
    service._write_cache({"deepseek": [{"id": "cached-chat", "name": "Cached Chat"}]})

    catalog = await service.list_models(str(tmp_path))
    assert [model.id for model in catalog.models] == ["cached-chat", "deepseek-chat"]
    assert catalog.warning is None

    async def _failing_fetch(_settings, _definition):
        return False

    monkeypatch.setattr(service, "_fetch_models", _failing_fetch)
    catalog = await service.list_models(str(tmp_path), refresh=True)

    assert catalog.warning is not None and "DeepSeek" in catalog.warning
    assert [model.id for model in catalog.models] == ["cached-chat", "deepseek-chat"]
    assert service._read_cache() == {"deepseek": [{"id": "cached-chat", "name": "Cached Chat"}]}


@pytest.mark.asyncio
async def test_list_models_keeps_other_providers_when_one_refresh_fails(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)
    service.credentials.set("deepseek", Credential(type="api_key", key="deepseek-key"))
    service.credentials.set("openai", Credential(type="api_key", key="openai-key"))
    service._write_cache({"deepseek": [{"id": "deepseek-cached"}], "openai": [{"id": "gpt-cached"}]})

    async def _fetch(_settings, definition):
        return definition.id != "openai"

    async def _refetch(_settings, definition):
        if definition.id == "openai":
            return False
        service._write_cache({"deepseek": [{"id": "deepseek-live"}], "openai": [{"id": "gpt-cached"}]})
        return True

    monkeypatch.setattr(service, "_fetch_models", _refetch)
    catalog = await service.list_models(str(tmp_path), refresh=True)

    by_provider = {(model.provider_id, model.id) for model in catalog.models}
    assert ("deepseek", "deepseek-live") in by_provider
    assert ("openai", "gpt-cached") in by_provider
    assert catalog.warning is not None and "OpenAI" in catalog.warning


@pytest.mark.asyncio
async def test_list_models_falls_back_to_builtin_catalog_without_cache(tmp_path: Path, monkeypatch) -> None:
    service = _service(tmp_path, _settings(tmp_path), monkeypatch)
    service.credentials.set("deepseek", Credential(type="api_key", key="deepseek-key"))

    catalog = await service.list_models(str(tmp_path))
    assert [model.id for model in catalog.models] == ["deepseek-chat", "deepseek-reasoner"]
    assert all(model.reasoning_efforts for model in catalog.models)


@pytest.mark.asyncio
async def test_list_models_hides_unconfigured_providers_and_appends_current(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path, provider="openai", model="gpt-5.5")
    service = _service(tmp_path, settings, monkeypatch)
    service.credentials.set("openai", Credential(type="api_key", key="openai-key"))

    catalog = await service.list_models(str(tmp_path))
    assert {model.provider_id for model in catalog.models} == {"openai"}
    assert [model.id for model in catalog.models] == ["gpt-5.5", "gpt-4o-mini"]


@pytest.mark.asyncio
async def test_create_chat_client_requires_configuration(tmp_path: Path, monkeypatch) -> None:
    service = _service(tmp_path, _settings(tmp_path), monkeypatch)

    with pytest.raises(ProviderError) as exc:
        await service.create_chat_client(str(tmp_path), ModelSelection("deepseek", "deepseek-chat"))

    assert exc.value.code == "provider_not_configured"
    assert "/login" in str(exc.value)
    assert "DEEPSEEK_API_KEY" in str(exc.value)


@pytest.mark.asyncio
async def test_create_chat_client_rejects_unknown_api(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)
    service.credentials.set("deepseek", Credential(type="api_key", key="deepseek-key"))
    service.providers["deepseek"] = SimpleNamespace(
        id="deepseek", name="DeepSeek", api="mystery-api", auth_methods=("api_key",),
        environment_key="DEEPSEEK_API_KEY", fallback_models=(), default_base_url="https://api.deepseek.com/v1",
    )

    with pytest.raises(ProviderError) as exc:
        await service.create_chat_client(str(tmp_path), ModelSelection("deepseek", "deepseek-chat"))

    assert exc.value.code == "unsupported_api"


def test_build_async_client_sets_rind_user_agent() -> None:
    client = build_async_client("key", "https://example.com/v1")

    assert client.api_key == "key"
    assert client.base_url == "https://example.com/v1/"
    assert client.default_headers["User-Agent"].startswith("rind/")


@pytest.mark.asyncio
async def test_unavailable_client_stream_raises_provider_error_for_turns() -> None:
    from agent.infrastructure.llm.provider_service import _UnavailableChatClient

    client = _UnavailableChatClient("deepseek-chat", "DeepSeek is not configured. Run /login or set DEEPSEEK_API_KEY.")

    with pytest.raises(ProviderError) as exc:
        async for _event in client.stream([], None):
            pass

    assert exc.value.code == "provider_not_configured"
    assert "Run /login" in str(exc.value)


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


@pytest.mark.asyncio
async def test_openai_responses_adapter_streams_text_reasoning_and_tool_call() -> None:
    raw_events = [
        SimpleNamespace(type="response.output_item.added", item=SimpleNamespace(type="function_call", call_id="call_1", id="item_1", name="bash")),
        SimpleNamespace(type="response.function_call_arguments.delta", item_id="item_1", delta='{"command":"pwd"}'),
        SimpleNamespace(type="response.output_text.delta", delta="hello"),
        SimpleNamespace(type="response.reasoning_summary_text.delta", delta="thinking"),
        SimpleNamespace(type="response.completed", response=SimpleNamespace(status="completed", usage=SimpleNamespace(input_tokens=8, output_tokens=3))),
    ]

    class Provider:
        class responses:
            @staticmethod
            async def create(**_kwargs):
                async def stream():
                    for event in raw_events:
                        yield event
                return stream()

    from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient

    client = OpenAIResponsesClient(Provider(), "gpt-5.5", "high")
    events = [event async for event in client.stream([], None)]

    assert [(event.kind, event.tool_call_id) for event in events] == [
        ("tool_start", "call_1"),
        ("tool_arguments_delta", "call_1"),
        ("text_delta", ""),
        ("reasoning_delta", ""),
        ("usage", ""),
        ("completed", ""),
    ]
    assert events[4].usage.input_tokens == 8
    assert events[5].stop_reason == "stop"


@pytest.mark.asyncio
async def test_anthropic_adapter_streams_blocks_and_maps_stop_reasons() -> None:
    raw_events = [
        SimpleNamespace(type="message_start", message=SimpleNamespace(usage=SimpleNamespace(input_tokens=11, output_tokens=0))),
        SimpleNamespace(type="content_block_start", content_block=SimpleNamespace(type="tool_use", id="call_1", name="bash")),
        SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type="input_json_delta", partial_json='{"command":"pwd"}')),
        SimpleNamespace(type="content_block_stop"),
        SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type="text_delta", text="hello")),
        SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type="thinking_delta", thinking="reasoning")),
        SimpleNamespace(type="message_delta", delta=SimpleNamespace(stop_reason="tool_use")),
    ]

    class Provider:
        class messages:
            @staticmethod
            async def create(**_kwargs):
                async def stream():
                    for event in raw_events:
                        yield event
                return stream()

    from agent.infrastructure.llm.anthropic_messages import AnthropicMessagesClient

    client = AnthropicMessagesClient(async_client=Provider(), api_key="key", model="claude-sonnet-4-6")
    events = [event async for event in client.stream([], None)]

    assert [event.kind for event in events] == [
        "usage", "tool_start", "tool_arguments_delta", "tool_end", "text_delta", "reasoning_delta", "completed",
    ]
    assert events[6].stop_reason == "tool_calls"
    assert events[0].usage.input_tokens == 11


def test_anthropic_adapter_converts_canonical_messages() -> None:
    from agent.infrastructure.llm.anthropic_messages import _messages

    messages = [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "function": {"name": "bash", "arguments": '{"command":"pwd"}'}},
        ]},
        {"role": "tool", "tool_call_id": "call_1", "content": "/workspace"},
    ]

    system, converted = _messages(messages)

    assert system == "be brief"
    assert converted == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "call_1", "name": "bash", "input": {"command": "pwd"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "call_1", "content": "/workspace"},
        ]},
    ]


def test_responses_adapter_converts_canonical_messages_to_input_items() -> None:
    from agent.infrastructure.llm.openai_responses import _input_items

    messages = [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "calling", "tool_calls": [
            {"id": "call_1", "function": {"name": "bash", "arguments": '{"command":"pwd"}'}},
        ]},
        {"role": "tool", "tool_call_id": "call_1", "content": "/workspace"},
    ]

    assert _input_items(messages) == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "calling"},
        {"type": "function_call", "call_id": "call_1", "name": "bash", "arguments": '{"command":"pwd"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": "/workspace"},
    ]
