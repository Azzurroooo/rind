"""Provider options stay local to the summary request."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import openai
import pytest

from agent.infrastructure.llm.anthropic_messages import AnthropicMessagesClient
from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.llm.openai_chat_client import OpenAIChatClient
from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient


@pytest.mark.asyncio
@pytest.mark.parametrize("api", ["chat", "responses"])
@pytest.mark.parametrize("configured,supported,expected", [
    ("high", ("low", "high"), "low"),
    ("high", (), "high"),
    ("", (), ""),
    ("none", ("none", "low"), "none"),
    ("minimal", ("minimal", "low"), "minimal"),
])
async def test_reasoning_and_output_overrides_do_not_change_next_request(api, configured, supported, expected):
    sdk = MagicMock()
    if api == "chat":
        send = sdk.chat.completions.create = AsyncMock(return_value={"choices": [{"message": {"content": "summary"}, "finish_reason": "stop"}]})
        client = OpenAIChatCompletionsClient(sdk, "model", configured, reasoning_efforts=supported)
        cap = "max_tokens"
    else:
        send = sdk.responses.create = AsyncMock(return_value={"status": "completed", "output": []})
        client = OpenAIResponsesClient(sdk, "model", configured, reasoning_efforts=supported)
        cap = "max_output_tokens"
    messages = [{"role": "user", "content": "summarize"}]
    await client.create(messages, max_output_tokens=8192, reasoning_effort="low")
    await client.create(messages)
    first, second = (call.kwargs for call in send.call_args_list)
    assert first[cap] == 8192
    assert cap not in second
    assert first["messages" if api == "chat" else "input"] == messages
    if api == "chat":
        assert first.get("reasoning_effort", "") == expected
        assert second.get("reasoning_effort", "") == configured
    else:
        assert first.get("reasoning", {}).get("effort", "") == expected
        assert second.get("reasoning", {}).get("effort", "") == configured


@pytest.mark.asyncio
@pytest.mark.parametrize("api", ["anthropic", "google"])
async def test_output_cap_without_unsupported_reasoning_parameters(api):
    sdk = MagicMock()
    if api == "anthropic":
        send = sdk.messages.create = AsyncMock(return_value={"content": [], "stop_reason": "end_turn"})
        client = AnthropicMessagesClient("key", "model", async_client=sdk)
    else:
        send = sdk.aio.models.generate_content = AsyncMock(return_value={"candidates": []})
        client = GoogleGenerativeAIClient("key", "model", client=sdk)
    await client.create([], max_output_tokens=8192, reasoning_effort="low")
    await client.create([])
    first, second = (call.kwargs for call in send.call_args_list)
    if api == "anthropic":
        assert first["max_tokens"] == 8192
        assert second["max_tokens"] == 32768
        assert "thinking" not in first and "reasoning_effort" not in first
    else:
        assert first["config"] == {"max_output_tokens": 8192}
        assert second["config"] == {}


@pytest.mark.asyncio
async def test_compatible_chat_keeps_cap_during_parameter_fallbacks():
    sdk = MagicMock()
    calls = []

    async def send(**payload):
        calls.append(payload)
        unsupported = "prompt_cache_key" if "prompt_cache_key" in payload else "max_tokens" if "max_tokens" in payload else None
        if unsupported:
            raise openai.BadRequestError(f"Unsupported parameter: {unsupported}", response=MagicMock(status_code=400), body=None)
        return "summary"

    sdk.chat.completions.create = send
    client = OpenAIChatClient(sdk, "model", "high", reasoning_efforts=("low", "high"))
    assert await client.create([], max_output_tokens=8192, reasoning_effort="low") == "summary"
    assert len(calls) == 3
    assert all(p.get("max_tokens", p.get("max_completion_tokens")) == 8192 for p in calls)
    assert all(p["reasoning_effort"] == "low" for p in calls)


@pytest.mark.asyncio
async def test_rejected_summary_effort_does_not_disable_normal_reasoning():
    sdk = MagicMock()
    error = openai.BadRequestError("Unsupported parameter: reasoning_effort", response=MagicMock(status_code=400), body=None)
    send = sdk.chat.completions.create = AsyncMock(side_effect=[error, "summary", "next reply"])
    client = OpenAIChatClient(sdk, "model", "high", reasoning_efforts=("low", "high"))
    await client.create([], max_output_tokens=8192, reasoning_effort="low")
    await client.create([])
    first, retry, next_turn = (call.kwargs for call in send.call_args_list)
    assert first["reasoning_effort"] == "low"
    assert "reasoning_effort" not in retry
    assert retry["max_tokens"] == 8192
    assert next_turn["reasoning_effort"] == "high"
    assert "max_tokens" not in next_turn


@pytest.mark.asyncio
@pytest.mark.parametrize("model,efforts", [("gpt-5.5", ("low", "medium", "high", "xhigh")), ("custom-model", ())])
async def test_factory_passes_only_known_reasoning_capabilities(tmp_path, monkeypatch, model, efforts):
    from agent.domain.models import Credential, ModelSelection
    from agent.infrastructure.llm.provider_service import ProviderServiceImpl
    from test_provider_auth import _settings

    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    service = ProviderServiceImpl()
    monkeypatch.setattr(service, "_resolve_credential", lambda *_: Credential(type="api_key", key="test"))
    monkeypatch.setattr("agent.infrastructure.llm.openai_chat_client.build_async_client", lambda *_args, **_kwargs: SimpleNamespace())
    factory = MagicMock()
    monkeypatch.setattr("agent.infrastructure.llm.openai_responses.OpenAIResponsesClient", factory)
    await service.create_chat_client(_settings(tmp_path, provider="openai"), ModelSelection("openai", model, "high"), workspace_root=str(tmp_path))
    assert factory.call_args.kwargs["reasoning_efforts"] == efforts
