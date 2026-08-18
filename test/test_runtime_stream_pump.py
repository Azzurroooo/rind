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

from agent.runtime.core.turn_runner import TurnRunner
from agent.domain.events import (
    AssistantDeltaEvent,
    AssistantMessageCompletedEvent,
    ContextBuiltEvent,
    ToolInputDeltaEvent,
    ToolInputEndedEvent,
    ToolInputStartedEvent,
    TurnCompletedEvent,
    TurnFailedEvent,
    TurnStepRetryEvent,
)
from agent.domain.errors import ProviderError
from agent.domain import ParsedToolCall


def make_runner(mock_parser):
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None
    mock_session = MagicMock()
    mock_session.now_iso.return_value = "2026-05-08T00:00:00Z"
    mock_session.persist_message = AsyncMock()

    runner = TurnRunner(
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
async def test_async_turn_runner_persists_reasoning_content():
    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("Answer", [], None, "Private reasoning"))
    runner, mock_session = make_runner(mock_parser)

    events = [event async for event in runner.run_turn(mock_session)]

    mock_session.persist_message.assert_awaited_once_with(
        "assistant",
        "Answer",
        reasoning_content="Private reasoning",
    )
    assert any(isinstance(event, AssistantMessageCompletedEvent) for event in events)


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


@pytest.mark.asyncio
async def test_async_turn_runner_forwards_tool_input_before_stream_completes():
    input_started = asyncio.Event()
    finish_stream = asyncio.Event()

    async def mock_consume(*args, **kwargs):
        on_started = args[3]
        on_delta = args[4]
        on_ended = args[5]
        await on_started("call_1", "write_file")
        await on_delta("call_1", "write_file", '{"file_path":"notes.txt"')
        input_started.set()
        await finish_stream.wait()
        await on_ended("call_1", "write_file")
        return "", []

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume
    runner, mock_session = make_runner(mock_parser)
    events = []

    async def collect_events():
        async for event in runner.run_turn(mock_session):
            events.append(event)

    task = asyncio.create_task(collect_events())
    await asyncio.wait_for(input_started.wait(), timeout=1)
    await asyncio.sleep(0)

    assert any(isinstance(event, ToolInputStartedEvent) for event in events)
    assert any(isinstance(event, ToolInputDeltaEvent) for event in events)
    assert not any(isinstance(event, ToolInputEndedEvent) for event in events)

    finish_stream.set()
    await asyncio.wait_for(task, timeout=1)
    assert any(isinstance(event, ToolInputEndedEvent) for event in events)


@pytest.mark.asyncio
async def test_turn_runner_recovers_interrupted_model_step() -> None:
    parser = MagicMock()
    parser.consume_async_stream = AsyncMock(
        side_effect=[
            ProviderError("connection dropped", status="unavailable", code="stream_interrupted"),
            ("recovered", [], None, None, "stop"),
        ]
    )
    runner, _session = make_runner(parser)
    runner._wait_for_recovery = AsyncMock()

    events = [event async for event in runner.run_turn(_session, turn_id="turn_recover")]

    assert sum(isinstance(event, TurnStepRetryEvent) for event in events) == 1
    assert sum(isinstance(event, AssistantMessageCompletedEvent) for event in events) == 1
    assert isinstance(events[-1], TurnCompletedEvent)
    assert parser.consume_async_stream.await_count == 2


@pytest.mark.asyncio
async def test_turn_runner_stops_after_step_recovery_limit() -> None:
    parser = MagicMock()
    parser.consume_async_stream = AsyncMock(
        side_effect=[ProviderError("connection dropped", status="unavailable", code="stream_interrupted")] * 4
    )
    runner, session = make_runner(parser)
    runner._wait_for_recovery = AsyncMock()

    events = [event async for event in runner.run_turn(session, turn_id="turn_exhausted")]

    assert sum(isinstance(event, TurnStepRetryEvent) for event in events) == 3
    assert isinstance(events[-1], TurnFailedEvent)
    assert parser.consume_async_stream.await_count == 4


@pytest.mark.asyncio
async def test_turn_runner_rejects_truncated_finish_reason() -> None:
    parser = MagicMock()
    parser.consume_async_stream = AsyncMock(return_value=("partial", [], None, None, "length"))
    runner, session = make_runner(parser)

    events = [event async for event in runner.run_turn(session, turn_id="turn_truncated")]

    assert isinstance(events[-1], TurnFailedEvent)
    assert events[-1].error_type == "StreamTruncated"
    session.persist_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_turn_runner_recovers_only_latest_assistant_tool_step() -> None:
    parser = MagicMock()
    runner, session = make_runner(parser)
    session.load_messages = AsyncMock(
        return_value=[
            {"role": "assistant", "meta": {"tool_calls": [{"id": "old", "name": "bash", "raw_args": "{}"}]}},
            {"role": "tool", "tool_call_id": "old", "content": ""},
            {"role": "assistant", "meta": {"tool_calls": [{"id": "current", "name": "bash", "raw_args": "{}"}]}},
        ]
    )
    session.get_tool_records = AsyncMock(return_value=[])

    assert await runner._pending_tool_calls(session) == [
        ParsedToolCall(call_id="current", name="bash", raw_args="{}")
    ]


def main() -> int:
    asyncio.run(test_async_turn_runner_stream())
    asyncio.run(test_async_turn_runner_persists_reasoning_content())
    asyncio.run(test_async_turn_runner_yields_delta_before_stream_completes())
    asyncio.run(test_async_turn_runner_cancels_stream_consumer_when_closed_early())
    asyncio.run(test_async_turn_runner_forwards_tool_input_before_stream_completes())
    print("Runtime stream pump tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
