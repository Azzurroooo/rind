import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import httpx
import openai

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.llm.cancellation import await_with_cancellation
from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient
from agent.infrastructure.llm.openai_chat_client import OpenAIChatClient


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_kind", ["token", "outer"])
async def test_cancel_reclaims_provider_and_waiter(cancel_kind):
    started = asyncio.Event()
    cleaned = asyncio.Event()
    source = CancellationTokenSource()
    before = asyncio.all_tasks()

    async def request():
        try:
            started.set()
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleaned.set()

    task = asyncio.create_task(await_with_cancellation(request(), source.token))
    await started.wait()
    if cancel_kind == "token":
        source.cancel("stop")
    else:
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned.is_set()
    assert asyncio.all_tasks() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_provider_completion_reclaims_cancel_waiter(fail):
    source = CancellationTokenSource()
    before = asyncio.all_tasks()

    async def request():
        if fail:
            raise ValueError("provider failed")
        return "done"

    if fail:
        with pytest.raises(ValueError, match="provider failed"):
            await await_with_cancellation(request(), source.token)
    else:
        assert await await_with_cancellation(request(), source.token) == "done"
    assert asyncio.all_tasks() == before


@pytest.mark.asyncio
async def test_simultaneous_completion_prefers_cancellation():
    source = CancellationTokenSource()

    async def request():
        source.cancel("stop")
        return "done"

    with pytest.raises(asyncio.CancelledError, match="stop"):
        await await_with_cancellation(request(), source.token)


@pytest.mark.asyncio
async def test_google_closes_async_and_sync_connections():
    sdk = SimpleNamespace(aio=SimpleNamespace(aclose=AsyncMock()), close=Mock())
    client = GoogleGenerativeAIClient("key", "model", client=sdk)
    await client.close()
    sdk.aio.aclose.assert_awaited_once()
    sdk.close.assert_called_once()


@pytest.mark.asyncio
async def test_sdk_is_the_only_retry_owner(monkeypatch):
    attempts = 0

    def respond(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(429, json={"error": {"message": "rate limit"}})

    sdk = openai.AsyncOpenAI(
        api_key="test", max_retries=14,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
    )
    monkeypatch.setattr(sdk, "_calculate_retry_timeout", lambda *args: 0)
    client = OpenAIChatClient(sdk, "model")
    try:
        from agent.domain.errors import ProviderError
        with pytest.raises(ProviderError):
            await client.create([{"role": "user", "content": "test"}])
        assert attempts == 15
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_cancellation_interrupts_sdk_retry_after():
    requested = asyncio.Event()
    source = CancellationTokenSource()
    attempts = 0

    def respond(request):
        nonlocal attempts
        attempts += 1
        requested.set()
        return httpx.Response(429, headers={"retry-after": "60"}, json={"error": {"message": "wait"}})

    sdk = openai.AsyncOpenAI(
        api_key="test", max_retries=14,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
    )
    client = OpenAIChatClient(sdk, "model")
    task = asyncio.create_task(client.create([], cancellation_token=source.token))
    try:
        await requested.wait()
        source.cancel("stop waiting")
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert attempts == 1
    finally:
        await client.close()
