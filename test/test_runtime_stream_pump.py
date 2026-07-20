import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.async_turn_runner import AsyncTurnRunner
from agent.domain.events import (
    AssistantDeltaEvent,
    AssistantMessageCompletedEvent,
    ContextBuiltEvent,
    TurnCompletedEvent,
)


def make_runner(mock_parser):
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None
    mock_session = MagicMock()
    mock_session.now_iso.return_value = "2026-05-08T00:00:00Z"
    mock_session.persist_message = AsyncMock()

    runner = AsyncTurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )
    return runner, mock_session


@pytest.mark.asyncio
async def test_async_turn_runner_stream():
    mock_parser = MagicMock()

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        await on_content_async("Hello ")
        await on_content_async("World!")
        return "Hello World!", []

    mock_parser.consume_async_stream = mock_consume
    runner, mock_session = make_runner(mock_parser)

    events = [event async for event in runner.run_turn(mock_session)]

    assert len(events) == 5
    assert isinstance(events[0], ContextBuiltEvent)
    assert isinstance(events[1], AssistantDeltaEvent)
    assert events[1].text == "Hello "
    assert isinstance(events[2], AssistantDeltaEvent)
    assert events[2].text == "World!"
    assert isinstance(events[3], AssistantMessageCompletedEvent)
    assert events[3].content_chars == len("Hello World!")
    assert isinstance(events[4], TurnCompletedEvent)


@pytest.mark.asyncio
async def test_async_turn_runner_yields_delta_before_stream_completes():
    delta_sent = asyncio.Event()
    finish_stream = asyncio.Event()

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        await on_content_async("partial")
        delta_sent.set()
        await finish_stream.wait()
        return "partial done", []

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume
    runner, mock_session = make_runner(mock_parser)

    events = []

    async def collect_events():
        async for event in runner.run_turn(mock_session):
            events.append(event)

    task = asyncio.create_task(collect_events())
    await asyncio.wait_for(delta_sent.wait(), timeout=1)
    await asyncio.sleep(0)

    assert any(isinstance(event, AssistantDeltaEvent) and event.text == "partial" for event in events)
    assert not any(isinstance(event, AssistantMessageCompletedEvent) for event in events)

    finish_stream.set()
    await asyncio.wait_for(task, timeout=1)
    assert any(isinstance(event, AssistantMessageCompletedEvent) for event in events)


@pytest.mark.asyncio
async def test_async_turn_runner_cancels_stream_consumer_when_closed_early():
    delta_sent = asyncio.Event()
    consumer_cancelled = asyncio.Event()
    keep_streaming = asyncio.Event()

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        await on_content_async("partial")
        delta_sent.set()
        try:
            await keep_streaming.wait()
        except asyncio.CancelledError:
            consumer_cancelled.set()
            raise
        return "partial done", []

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume
    runner, mock_session = make_runner(mock_parser)

    stream = runner.run_turn(mock_session)
    event = await asyncio.wait_for(stream.__anext__(), timeout=1)
    assert isinstance(event, ContextBuiltEvent)
    event = await asyncio.wait_for(stream.__anext__(), timeout=1)
    assert isinstance(event, AssistantDeltaEvent)
    assert event.text == "partial"
    assert delta_sent.is_set()

    await stream.aclose()

    await asyncio.wait_for(consumer_cancelled.wait(), timeout=1)


def main() -> int:
    asyncio.run(test_async_turn_runner_stream())
    asyncio.run(test_async_turn_runner_yields_delta_before_stream_completes())
    asyncio.run(test_async_turn_runner_cancels_stream_consumer_when_closed_early())
    print("Runtime stream pump tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
