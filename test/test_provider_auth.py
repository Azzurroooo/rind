from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.domain.errors import ProviderError
from agent.domain.models import Credential, ModelSelection, ModelUsage
from agent.domain.tool_payload import ParsedToolCall
from agent.infrastructure.credentials import CredentialStore
from agent.infrastructure.settings import AppSettings
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.llm.provider_service import build_async_client
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


@pytest.mark.asyncio
@pytest.mark.parametrize("cached,endpoint,expected", [
    (False, "https://api.openai.com/v1", False),
    (True, "https://api.openai.com/v1", True),
    ("false", "https://api.openai.com/v1", True),
    (None, "https://api.openai.com/v1", True),
    (None, "https://proxy.example/v1", None),
])
async def test_image_capability_cache_builtin_unknown_agree_in_list_and_selection(tmp_path, monkeypatch, cached, endpoint, expected):
    settings = _settings(tmp_path, provider="openai", model="gpt-4o-mini", api_key="test", base_url=endpoint)
    service = _service(tmp_path, settings, monkeypatch)
    service._write_cache({"openai": {"models": [{"id": "gpt-4o-mini", "image_input": cached}],
                                     "base_url": endpoint, "refreshed_at": 1}})
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.build_async_client", lambda *a, **k: pytest.fail("Local reads must not use network"))
    catalog = await service.list_models()
    selected = service.resolve_selection(None, ModelSelection("openai", "gpt-4o-mini"))
    assert selected.image_input is expected
    assert next(m for m in catalog.models if m.provider_id == "openai" and m.id == selected.id).image_input is expected


@pytest.mark.asyncio
async def test_image_capability_does_not_inherit_another_endpoint_or_legacy_metadata(tmp_path, monkeypatch):
    settings = _settings(tmp_path, provider="openai", model="custom", api_key="test", base_url="https://proxy.example/v1")
    service = _service(tmp_path, settings, monkeypatch)
    for entry in ([{"id": "custom", "image_input": True}],
                  {"models": [{"id": "custom", "image_input": True}], "base_url": "https://other.example/v1", "refreshed_at": 1}):
        service._write_cache({"openai": entry})
        assert service.resolve_selection(None, ModelSelection("openai", "custom")).image_input is None


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,endpoint,model,expected", [
    ("deepseek", "https://api.deepseek.com", "deepseek-flash", True),
    ("deepseek", "https://api.deepseek.com/v1/", "deepseek-v4-pro", False),
    ("openai-compatible", "https://api.deepseek.com/", "deepseek-flash", True),
    ("openai-compatible", "https://api.deepseek.com/v1", "deepseek-v4-pro", False),
    ("openai-compatible", "https://api.openai.com/v1", "gpt-4o-mini", True),
    ("openai-compatible", "https://api.deepseek.com", "unlisted-model", None),
    ("openai-compatible", "https://proxy.example/v1", "deepseek-flash", None),
    ("openai-compatible", "https://api.deepseek.com.proxy.example", "deepseek-flash", None),
    ("openai-compatible", "https://api.deepseek.com/v2", "deepseek-flash", None),
    ("openai-compatible", "https://api.deepseek.com?proxy=1", "deepseek-flash", None),
    ("openai-compatible", "http://api.deepseek.com", "deepseek-flash", None),
    ("openai", "https://api.deepseek.com", "gpt-4o-mini", None),
    ("deepseek", "https://api.deepseek.com", "deepseek-v4-flash", True),
    ("qwen-coding", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "deepseek-v4-flash", False),
    ("openai-compatible", "https://openrouter.ai/api/v1", "deepseek/deepseek-v4-flash", False),
])
async def test_image_catalog_matches_official_endpoint_and_model(tmp_path, monkeypatch, provider, endpoint, model, expected):
    settings = _settings(tmp_path, provider=provider, model=model, api_key="test", base_url=endpoint)
    service = _service(tmp_path, settings, monkeypatch)
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.build_async_client", lambda *a, **k: pytest.fail("Catalog reads must stay offline"))
    selected = service.resolve_selection(None, ModelSelection(provider, model))
    listed = next(m for m in (await service.list_models()).models if m.provider_id == provider and m.id == model)
    assert selected.image_input is listed.image_input is expected
    assert selected.provider_id == provider


@pytest.mark.asyncio
async def test_compatible_endpoint_cache_false_overrides_official_catalog(tmp_path, monkeypatch):
    endpoint = "https://api.deepseek.com"
    settings = _settings(tmp_path, provider="openai-compatible", model="deepseek-flash", api_key="test", base_url=endpoint)
    service = _service(tmp_path, settings, monkeypatch)
    service._write_cache({"openai-compatible": {"base_url": endpoint, "refreshed_at": 1,
        "models": [{"id": "deepseek-flash", "image_input": False}]}})
    assert service.resolve_selection(None, ModelSelection("openai-compatible", "deepseek-flash")).image_input is False
    assert (await service.list_models()).models[0].image_input is False
    assert service._read_cache()["openai-compatible"]["refreshed_at"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["background", "login", "explicit"])
@pytest.mark.parametrize("same_endpoint", [True, False])
async def test_all_refresh_entries_merge_capabilities_by_endpoint(tmp_path, monkeypatch, trigger, same_endpoint):
    from unittest.mock import AsyncMock, Mock
    settings = _settings(tmp_path, provider="openrouter", model="new", api_key="test", base_url="https://openrouter.ai/api/v1")
    service = _service(tmp_path, settings, monkeypatch)
    for provider in service.providers.values():
        monkeypatch.delenv(provider.environment_key or "UNUSED_TEST_KEY", raising=False)
    service._write_cache({"openrouter": {"base_url": settings.base_url if same_endpoint else "https://old.example/v1", "refreshed_at": 0,
        "models": [{"id": "old", "image_input": True}, {"id": "keep", "image_input": False}, {"id": "removed", "image_input": True}]}})
    listing = AsyncMock(return_value=SimpleNamespace(data=[
        {"id": "old", "architecture": {"input_modalities": ["text"]}},
        {"id": "new", "name": "New vision model", "architecture": {"input_modalities": ["text", "image"]}},
        {"id": "keep"}, {"id": "unknown", "vision": True},
    ]))
    client = SimpleNamespace(models=SimpleNamespace(list=listing), close=AsyncMock())
    build = Mock(return_value=client)
    monkeypatch.setattr("agent.infrastructure.llm.provider_service.build_async_client", build)
    if trigger == "background":
        await service.refresh_stale_models()
    elif trigger == "login":
        await service.login(None, "openrouter", "api_key", _PromptInteraction("stored-test"))
    else:
        await service.list_models(refresh=True)
    assert build.call_args.kwargs["max_retries"] == 0
    listing.assert_awaited_once_with(timeout=10)
    client.close.assert_awaited_once()
    entry = service._read_cache()["openrouter"]
    models = {m["id"]: m for m in entry["models"]}
    assert models["old"]["image_input"] is False
    assert models["new"]["image_input"] is True
    assert models["new"]["name"] == "New vision model"
    assert models["keep"].get("image_input") is (False if same_endpoint else None)
    assert "image_input" not in models["unknown"] and "removed" not in models
    assert entry["refreshed_at"] > 0 and entry["base_url"] == settings.base_url


@pytest.mark.parametrize("provider,item,expected", [
    ("openrouter", {"architecture": {"input_modalities": ["image", "text"]}}, True),
    ("openrouter", {"architecture": {"input_modalities": ["text"]}}, False),
    ("openrouter", {"architecture": {"input_modalities": "image"}}, None),
    ("openrouter", {"architecture": {"input_modalities": []}}, None),
    ("openrouter", {"input_modalities": ["image"]}, None),
    ("mistral", {"capabilities": {"vision": True}}, True),
    ("mistral", {"capabilities": {"vision": False}}, False),
    ("mistral", {"capabilities": {"vision": "false"}}, None),
    ("openai", {"capabilities": {"vision": True}}, None),
])
def test_remote_image_capability_only_uses_verified_schemas(provider, item, expected):
    from agent.infrastructure.llm.provider_service import _remote_image_input
    assert _remote_image_input(item, provider) is expected


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
    from agent.infrastructure.llm.catalog import default_reasoning_efforts

    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)
    service.credentials.set("deepseek", Credential(type="api_key", key="deepseek-key"))
    service._write_cache({"deepseek": [{"id": "cached-chat", "name": "Cached Chat"}]})

    catalog = await service.list_models(str(tmp_path))
    assert [model.id for model in catalog.models] == ["cached-chat", "deepseek-chat"]
    assert catalog.warning is None
    # Refreshed /models responses carry no effort metadata, so cache entries use the dialect default.
    assert catalog.models[0].reasoning_efforts == default_reasoning_efforts("openai-chat")

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
async def test_list_models_refreshed_entries_keep_verified_efforts(tmp_path: Path, monkeypatch) -> None:
    from agent.infrastructure.llm.catalog import default_reasoning_efforts

    service = _service(tmp_path, _settings(tmp_path), monkeypatch)
    service.credentials.set("zhipu", Credential(type="api_key", key="zhipu-key"))
    service._write_cache({"zhipu": [{"id": "glm-5.3", "name": "GLM-5.3"}, {"id": "glm-4.5", "name": "GLM-4.5"}]})

    catalog = await service.list_models(str(tmp_path))
    efforts = {model.id: model.reasoning_efforts for model in catalog.models}
    assert efforts["glm-5.3"] == ("low", "high", "max")
    assert efforts["glm-4.5"] == default_reasoning_efforts("openai-chat")


@pytest.mark.asyncio
async def test_list_models_falls_back_to_builtin_catalog_without_cache(tmp_path: Path, monkeypatch) -> None:
    service = _service(tmp_path, _settings(tmp_path), monkeypatch)
    service.credentials.set("deepseek", Credential(type="api_key", key="deepseek-key"))

    catalog = await service.list_models(str(tmp_path))
    assert [model.id for model in catalog.models] == [
        "deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp",
        "deepseek-chat", "deepseek-reasoner",
    ]
    assert all(model.reasoning_efforts for model in catalog.models)


@pytest.mark.asyncio
async def test_list_models_hides_unconfigured_providers_and_appends_current(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path, provider="openai", model="gpt-5.5")
    service = _service(tmp_path, settings, monkeypatch)
    service.credentials.set("openai", Credential(type="api_key", key="openai-key"))

    catalog = await service.list_models(str(tmp_path))
    assert {model.provider_id for model in catalog.models} == {"openai"}
    assert {"gpt-5.5", "gpt-4o-mini", "gpt-6-astra"} <= {model.id for model in catalog.models}


@pytest.mark.asyncio
async def test_create_chat_client_requires_configuration(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    service = _service(tmp_path, settings, monkeypatch)

    with pytest.raises(ProviderError) as exc:
        await service.create_chat_client(settings, ModelSelection("deepseek", "deepseek-chat"), workspace_root=str(tmp_path))

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
        await service.create_chat_client(settings, ModelSelection("deepseek", "deepseek-chat"), workspace_root=str(tmp_path))

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


def test_registry_covers_mainstream_providers() -> None:
    from agent.infrastructure.llm.catalog import PROVIDERS, default_reasoning_efforts, refreshable_models_api

    assert PROVIDERS["google"].api == "google-generative-ai"
    assert PROVIDERS["google"].environment_key == "GEMINI_API_KEY"
    assert {"gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-2.5-pro"} <= {model.id for model in PROVIDERS["google"].fallback_models}
    assert PROVIDERS["xai"].api == "openai-responses"
    for provider_id, environment_key in (
        ("groq", "GROQ_API_KEY"),
        ("mistral", "MISTRAL_API_KEY"),
        ("zai", "ZAI_API_KEY"),
        ("zai-coding", "ZAI_CODING_API_KEY"),
        ("zhipu", "ZHIPU_API_KEY"),
        ("zhipu-coding", "ZHIPU_CODING_API_KEY"),
        ("moonshot", "MOONSHOT_API_KEY"),
        ("moonshot-cn", "MOONSHOT_CN_API_KEY"),
        ("qwen", "DASHSCOPE_API_KEY"),
        ("qwen-coding", "QWEN_CODING_API_KEY"),
    ):
        assert PROVIDERS[provider_id].api == "openai-chat"
        assert PROVIDERS[provider_id].environment_key == environment_key
        assert PROVIDERS[provider_id].default_base_url.startswith("https://")
        assert len(PROVIDERS[provider_id].fallback_models) >= 2
    # Pay-as-you-go and coding-plan subscriptions are separate products
    # with separate keys and endpoints.
    assert PROVIDERS["zai"].default_base_url == "https://api.z.ai/api/paas/v4"
    assert PROVIDERS["zai-coding"].default_base_url == "https://api.z.ai/api/coding/paas/v4"
    assert PROVIDERS["zhipu"].default_base_url == "https://open.bigmodel.cn/api/paas/v4"
    assert PROVIDERS["zhipu-coding"].default_base_url == "https://open.bigmodel.cn/api/coding/paas/v4"
    assert PROVIDERS["moonshot-cn"].default_base_url == "https://api.moonshot.cn/v1"
    assert PROVIDERS["kimi-coding"].api == "anthropic-messages"
    assert PROVIDERS["kimi-coding"].environment_key == "KIMI_API_KEY"
    assert {"kimi-for-coding", "k3", "k3-256k"} <= {model.id for model in PROVIDERS["kimi-coding"].fallback_models}
    assert refreshable_models_api("openai-chat") and refreshable_models_api("openai-responses")
    assert not refreshable_models_api("google-generative-ai") and not refreshable_models_api("anthropic-messages")
    assert default_reasoning_efforts("google-generative-ai") == ()
    assert default_reasoning_efforts("openai-chat") == ("low", "medium", "high", "xhigh", "max")


def test_fallback_models_declare_per_model_reasoning_efforts() -> None:
    from agent.infrastructure.llm.catalog import PROVIDERS, default_reasoning_efforts

    def _efforts(provider_id: str, model_id: str) -> tuple[str, ...]:
        return next(model.reasoning_efforts for model in PROVIDERS[provider_id].fallback_models if model.id == model_id)

    assert _efforts("openai", "gpt-5.5") == ("low", "medium", "high", "xhigh")
    assert _efforts("openai", "gpt-4o-mini") == ()
    assert _efforts("zhipu", "glm-5.3") == ("low", "high", "max")
    assert _efforts("zhipu", "glm-5.2") == ("high", "max")
    assert _efforts("moonshot", "kimi-k2.6") == ()
    # Unverified legacy aliases keep the dialect default.
    assert _efforts("deepseek", "deepseek-chat") == default_reasoning_efforts("openai-chat")


def _google_chunk(parts, finish_reason=None, usage=None):
    return SimpleNamespace(
        candidates=[SimpleNamespace(content=SimpleNamespace(parts=parts), finish_reason=finish_reason)],
        usage_metadata=usage,
    )


@pytest.mark.asyncio
async def test_google_adapter_streams_text_reasoning_and_tool_call() -> None:
    from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient

    chunks = [
        _google_chunk([SimpleNamespace(text="hel", thought=None, function_call=None)]),
        _google_chunk([SimpleNamespace(text="ponder", thought=True, function_call=None)]),
        _google_chunk(
            [SimpleNamespace(text=None, thought=None, function_call={"id": "fc_1", "name": "bash", "args": {"command": "pwd"}})],
            finish_reason="FinishReason.STOP",
            usage={"prompt_token_count": 10, "candidates_token_count": 5, "thoughts_token_count": 3, "cached_content_token_count": 2},
        ),
    ]

    class Provider:
        class aio:
            class models:
                @staticmethod
                async def generate_content_stream(**_kwargs):
                    async def stream():
                        for chunk in chunks:
                            yield chunk
                    return stream()

    client = GoogleGenerativeAIClient(api_key="key", model="gemini-3-flash", client=Provider())
    events = [event async for event in client.stream([], None)]

    assert [(event.kind, event.tool_call_id) for event in events] == [
        ("text_delta", ""),
        ("reasoning_delta", ""),
        ("usage", ""),
        ("tool_start", "fc_1"),
        ("tool_arguments_delta", "fc_1"),
        ("tool_end", "fc_1"),
        ("completed", ""),
    ]
    assert events[4].arguments == '{"command": "pwd"}'
    assert events[2].usage == ModelUsage(10, 5, 2, 3)
    assert events[6].stop_reason == "stop"


@pytest.mark.asyncio
async def test_google_adapter_create_maps_completion() -> None:
    from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient

    response = _google_chunk(
        [
            SimpleNamespace(text="ponder", thought=True, function_call=None),
            SimpleNamespace(text="hello", thought=None, function_call=None),
            SimpleNamespace(text=None, thought=None, function_call={"id": "fc_1", "name": "bash", "args": {"command": "pwd"}}),
        ],
        finish_reason="FinishReason.STOP",
        usage={"prompt_token_count": 4, "candidates_token_count": 6},
    )

    class Provider:
        class aio:
            class models:
                @staticmethod
                async def generate_content(**_kwargs):
                    return response

    client = GoogleGenerativeAIClient(api_key="key", model="gemini-3-flash", client=Provider())
    completion = await client.create([], None)

    assert completion.content == "hello"
    assert completion.reasoning_content == "ponder"
    assert completion.tool_calls == (ParsedToolCall("fc_1", "bash", '{"command": "pwd"}'),)
    assert completion.usage == ModelUsage(4, 6, 0, 0)
    assert completion.finish_reason == "stop"


def test_google_adapter_converts_canonical_messages() -> None:
    from agent.infrastructure.llm.google_generative_ai import _request

    messages = [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "function": {"name": "bash", "arguments": '{"command":"pwd"}'}},
        ]},
        {"role": "tool", "tool_call_id": "call_1", "content": "/workspace"},
    ]
    tools = [{"type": "function", "function": {"name": "bash", "description": "run", "parameters": {"type": "object"}}}]

    contents, config = _request(messages, tools, True)

    assert config == {
        "system_instruction": "be brief",
        "tools": [{"function_declarations": [{"name": "bash", "description": "run", "parameters": {"type": "object"}}]}],
    }
    assert contents == [
        {"role": "user", "parts": [{"text": "hello"}]},
        {"role": "model", "parts": [{"function_call": {"name": "bash", "args": {"command": "pwd"}, "id": "call_1"}}]},
        {"role": "user", "parts": [{"function_response": {"name": "bash", "response": {"output": "/workspace"}, "id": "call_1"}}]},
    ]


def test_google_adapter_merges_tool_results_and_omits_ids_for_older_models() -> None:
    from agent.infrastructure.llm.google_generative_ai import _request

    messages = [
        {"role": "assistant", "tool_calls": [
            {"id": "a", "function": {"name": "bash", "arguments": "{}"}},
            {"id": "b", "function": {"name": "read_file", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "a", "content": "1"},
        {"role": "tool", "tool_call_id": "b", "content": "2"},
    ]

    contents, config = _request(messages, None, False)

    assert config == {}
    assert contents == [
        {"role": "model", "parts": [
            {"function_call": {"name": "bash", "args": {}}},
            {"function_call": {"name": "read_file", "args": {}}},
        ]},
        {"role": "user", "parts": [
            {"function_response": {"name": "bash", "response": {"output": "1"}}},
            {"function_response": {"name": "read_file", "response": {"output": "2"}}},
        ]},
    ]


@pytest.mark.asyncio
async def test_provider_service_creates_google_client_from_environment(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "gem")
    settings = _settings(tmp_path, provider="google", model="gemini-3-flash")
    service = _service(tmp_path, settings, monkeypatch)

    from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient

    client = await service.create_chat_client(settings, ModelSelection("google", "gemini-3-flash", ""), workspace_root=str(tmp_path))
    assert isinstance(client, GoogleGenerativeAIClient)
    await client.close()


def test_resolve_selection_uses_configured_model_definition(tmp_path, monkeypatch):
    service = _service(tmp_path, _settings(tmp_path), monkeypatch)
    model = service.resolve_selection(str(tmp_path), ModelSelection("deepseek", "deepseek-chat", ""))
    assert model.id == "deepseek-chat"
    assert model.provider_id == "deepseek"
