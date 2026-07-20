import pytest
import asyncio
import openai
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.llm.openai_async_chat_client import AsyncOpenAIChatClient
from agent.application.runtime.cancellation import CancellationTokenSource

@pytest.mark.asyncio
async def test_openai_async_client_cancellation():
    mock_openai = MagicMock()
    mock_create = AsyncMock()

    # Simulate a slow API call
    async def slow_create(*args, **kwargs):
        await asyncio.sleep(0.5)
        return "Done"

    mock_create.side_effect = slow_create
    mock_openai.chat.completions.create = mock_create

    client = AsyncOpenAIChatClient(mock_openai, "test-model")
    source = CancellationTokenSource()

    # Schedule cancellation
    async def cancel_later():
        await asyncio.sleep(0.1)
        source.cancel("Timeout")

    asyncio.create_task(cancel_later())

    with pytest.raises(asyncio.CancelledError) as exc:
        await client.create([{"role": "user", "content": "hi"}], cancellation_token=source.token)

    assert "Timeout" in str(exc.value)


@pytest.mark.asyncio
async def test_openai_async_client_cancellation_waits_for_api_task_cleanup():
    mock_openai = MagicMock()
    cleanup_finished = asyncio.Event()

    async def slow_create(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleanup_finished.set()

    mock_openai.chat.completions.create = AsyncMock(side_effect=slow_create)
    client = AsyncOpenAIChatClient(mock_openai, "test-model")
    source = CancellationTokenSource()

    async def cancel_later():
        await asyncio.sleep(0)
        source.cancel("User interrupted")

    asyncio.create_task(cancel_later())

    with pytest.raises(asyncio.CancelledError):
        await client.create([{"role": "user", "content": "hi"}], cancellation_token=source.token)

    assert cleanup_finished.is_set()


@pytest.mark.asyncio
async def test_openai_async_client_close_stream_prefers_aclose():
    class FakeStream:
        def __init__(self):
            self.closed = False

        async def aclose(self):
            self.closed = True

    stream = FakeStream()
    client = AsyncOpenAIChatClient(MagicMock(), "test-model")

    await client._close_stream(stream)

    assert stream.closed is True


@pytest.mark.asyncio
async def test_openai_async_client_close_stream_accepts_sync_close():
    class FakeStream:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    stream = FakeStream()
    client = AsyncOpenAIChatClient(MagicMock(), "test-model")

    await client._close_stream(stream)

    assert stream.closed is True


@pytest.mark.asyncio
async def test_openai_async_client_adds_reasoning_effort_when_configured():
    mock_openai = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(return_value="Done")
    client = AsyncOpenAIChatClient(mock_openai, "test-model", reasoning_effort="xhigh")

    result = await client.create([{"role": "user", "content": "hi"}])

    assert result == "Done"
    kwargs = mock_openai.chat.completions.create.call_args.kwargs
    assert kwargs["reasoning_effort"] == "xhigh"


@pytest.mark.asyncio
async def test_openai_async_client_adds_stable_prompt_cache_key():
    mock_openai = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(return_value="Done")
    client = AsyncOpenAIChatClient(mock_openai, "test-model")
    messages = [
        {"role": "system", "content": "stable system"},
        {"role": "user", "content": "first"},
    ]

    await client.create(messages)
    first_key = mock_openai.chat.completions.create.call_args.kwargs["prompt_cache_key"]
    await client.create([{**messages[0]}, {"role": "user", "content": "second"}])
    second_key = mock_openai.chat.completions.create.call_args.kwargs["prompt_cache_key"]

    assert first_key.startswith("tangerine:")
    assert first_key == second_key


@pytest.mark.asyncio
async def test_openai_async_client_retries_without_unsupported_prompt_cache_key():
    mock_openai = MagicMock()
    calls = []

    async def fake_create(**kwargs):
        calls.append(dict(kwargs))
        if len(calls) == 1:
            raise openai.BadRequestError(
                "Unsupported parameter: prompt_cache_key",
                response=MagicMock(status_code=400),
                body=None,
            )
        return "Done"

    mock_openai.chat.completions.create = AsyncMock(side_effect=fake_create)
    client = AsyncOpenAIChatClient(mock_openai, "test-model")

    result = await client.create([{"role": "user", "content": "hi"}])
    second = await client.create([{"role": "user", "content": "again"}])

    assert result == "Done"
    assert second == "Done"
    assert "prompt_cache_key" in calls[0]
    assert "prompt_cache_key" not in calls[1]
    assert "prompt_cache_key" not in calls[2]


@pytest.mark.asyncio
async def test_openai_async_client_set_model_updates_next_request():
    mock_openai = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(return_value="Done")
    client = AsyncOpenAIChatClient(mock_openai, "old-model")

    client.set_model("new-model")
    result = await client.create([{"role": "user", "content": "hi"}])

    assert result == "Done"
    assert client.model == "new-model"
    assert mock_openai.chat.completions.create.call_args.kwargs["model"] == "new-model"


@pytest.mark.asyncio
async def test_openai_async_client_disables_unsupported_reasoning_effort_once():
    mock_openai = MagicMock()
    calls = []

    async def fake_create(**kwargs):
        calls.append(dict(kwargs))
        if len(calls) == 1:
            raise openai.BadRequestError(
                "Unsupported parameter: reasoning_effort",
                response=MagicMock(status_code=400),
                body=None,
            )
        return "Done"

    mock_openai.chat.completions.create = AsyncMock(side_effect=fake_create)
    client = AsyncOpenAIChatClient(mock_openai, "test-model", reasoning_effort="xhigh")

    result = await client.create([{"role": "user", "content": "hi"}])
    second = await client.create([{"role": "user", "content": "again"}])

    assert result == "Done"
    assert second == "Done"
    assert "reasoning_effort" in calls[0]
    assert "reasoning_effort" not in calls[1]
    assert "reasoning_effort" not in calls[2]


@pytest.mark.asyncio
async def test_openai_async_client_retries_blocked_request_without_reasoning_effort():
    mock_openai = MagicMock()
    calls = []

    async def fake_create(**kwargs):
        calls.append(dict(kwargs))
        if len(calls) == 1:
            raise openai.BadRequestError(
                "Your request was blocked.",
                response=MagicMock(status_code=400),
                body=None,
            )
        return "Done"

    mock_openai.chat.completions.create = AsyncMock(side_effect=fake_create)
    client = AsyncOpenAIChatClient(mock_openai, "test-model", reasoning_effort="xhigh")

    result = await client.create([{"role": "user", "content": "hi"}])

    assert result == "Done"
    assert "reasoning_effort" in calls[0]
    assert "reasoning_effort" not in calls[1]
