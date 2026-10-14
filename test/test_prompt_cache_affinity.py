from unittest.mock import AsyncMock, MagicMock

import openai
import pytest

from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type", [OpenAIChatCompletionsClient, OpenAIResponsesClient])
async def test_cache_affinity_survives_dynamic_context_and_follows_session(client_type):
    sdk = MagicMock()
    send = AsyncMock(return_value={"choices": [], "output": [], "status": "completed"})
    sdk.chat.completions.create = sdk.responses.create = send
    client = client_type(sdk, "model")
    await client.create([])
    assert "prompt_cache_key" not in send.call_args.kwargs
    session_id = "session-1"
    client.set_session_id_provider(lambda: session_id)
    await client.create([{"role": "system", "content": "cwd A; date A; goal active"}])
    first = send.call_args.kwargs["prompt_cache_key"]
    await client.create([{"role": "system", "content": "cwd B; date B; new RIND.md; goal complete"}], tools=[])
    assert send.call_args.kwargs["prompt_cache_key"] == first
    session_id = "session-2" * 100
    await client.create([])
    assert send.call_args.kwargs["prompt_cache_key"] != first
    assert len(send.call_args.kwargs["prompt_cache_key"]) <= 64


@pytest.mark.asyncio
@pytest.mark.parametrize("client_type", [OpenAIChatCompletionsClient, OpenAIResponsesClient])
@pytest.mark.parametrize("stream", [False, True])
async def test_cache_rejection_fallback_is_retained_for_later_requests(client_type, stream):
    sdk = MagicMock()
    calls = []

    async def empty_stream():
        if False:
            yield

    async def send(**payload):
        calls.append(dict(payload))
        if len(calls) == 1:
            raise openai.BadRequestError("Unsupported parameter: prompt_cache_key", response=MagicMock(status_code=400), body=None)
        return empty_stream() if stream else {"choices": [], "output": [], "status": "completed"}

    sdk.chat.completions.create = sdk.responses.create = send
    client = client_type(sdk, "model")
    client.set_session_id_provider(lambda: "session")
    for _ in range(2):
        if stream:
            async for _event in client.stream([]):
                pass
        else:
            await client.create([])
    assert "prompt_cache_key" in calls[0]
    assert all("prompt_cache_key" not in call for call in calls[1:])
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_protocols_use_the_same_session_affinity():
    sdk = MagicMock()
    send = AsyncMock(return_value={"choices": [], "output": [], "status": "completed"})
    sdk.chat.completions.create = sdk.responses.create = send
    clients = [OpenAIChatCompletionsClient(sdk, "chat-model"), OpenAIResponsesClient(sdk, "responses-model")]
    for client in clients:
        client.set_session_id_provider(lambda: "session")
        await client.create([])
    assert send.call_args_list[0].kwargs["prompt_cache_key"] == send.call_args_list[1].kwargs["prompt_cache_key"]
