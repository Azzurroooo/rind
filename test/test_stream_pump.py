import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.domain.cancellation import CancellationTokenSource
from agent.domain.models import ModelStreamEvent
from agent.runtime.core.stream_parser import MessageStreamParser
from agent.runtime.core.stream_pump import ModelStreamResult, pump_model_stream_events


def pump(stream, source=None, session_id="session"):
    result = ModelStreamResult()
    return pump_model_stream_events(
        stream_response=stream, stream_parser=MessageStreamParser(),
        session=SimpleNamespace(session_id=session_id, model="fixture"), turn_id="turn",
        cancellation_token=source.token if source else None, context_stats={},
        persist_sampling_usage=AsyncMock(), result=result,
    ), result


@pytest.mark.asyncio
async def test_batches_text_without_crossing_tool_boundaries_and_preserves_large_arguments():
    arguments = '"' + "中文👩‍💻" * 50000 + '"'

    async def stream():
        for text in ["a", "b", "c"]:
            yield ModelStreamEvent(kind="text_delta", text=text)
        yield ModelStreamEvent(kind="tool_start", tool_call_id="a", tool_name="bash")
        yield ModelStreamEvent(kind="tool_arguments_delta", tool_call_id="a", arguments=arguments)
        yield ModelStreamEvent(kind="tool_end", tool_call_id="a")
        yield ModelStreamEvent(kind="text_delta", text="tail")

    iterator, result = pump(stream())
    events = [event async for event in iterator]
    assert events[0].text == "abc"
    assert events[1].type == "tool_input_started"
    assert "".join(event.delta for event in events if event.type == "tool_input_delta") == arguments
    assert events[-2].type == "tool_input_ended"
    assert events[-1].text == "tail"
    assert result.content == "abctail"
    assert result.tool_calls[0].raw_args == arguments
    assert {event.session_id for event in events} == {"session"}


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["x", "😀" * 2048])
async def test_slow_consumer_backpressures_source_and_full_queue_cancel_closes_stream(text):
    produced = 0
    closed = asyncio.Event()
    source = CancellationTokenSource()
    before = asyncio.all_tasks()

    async def stream():
        nonlocal produced
        try:
            for _ in range(100000):
                produced += 1
                yield ModelStreamEvent(kind="text_delta", text=text)
        finally:
            closed.set()

    iterator, _ = pump(stream(), source)
    await anext(iterator)
    await asyncio.sleep(0.02)
    at_capacity = produced
    await asyncio.sleep(0.02)
    assert produced == at_capacity
    if len(text) > 1:
        assert produced < 132, "the byte limit applies before the event-count limit"
    source.cancel("stop")
    await asyncio.wait_for(closed.wait(), 1)
    await iterator.aclose()
    assert asyncio.all_tasks() == before


@pytest.mark.asyncio
async def test_text_flushes_during_stalled_network_and_error_follows_prior_text():
    gate = asyncio.Event()

    async def stream():
        yield ModelStreamEvent(kind="text_delta", text="first")
        await gate.wait()
        raise ValueError("provider failed")

    iterator, _ = pump(stream())
    assert (await asyncio.wait_for(anext(iterator), 0.5)).text == "first"
    gate.set()
    with pytest.raises(ValueError, match="provider failed"):
        await anext(iterator)


@pytest.mark.asyncio
async def test_simultaneous_sessions_never_share_batches():
    async def stream(label):
        for _ in range(20):
            await asyncio.sleep(0)
            yield ModelStreamEvent(kind="text_delta", text=label)

    async def collect(label):
        iterator, _ = pump(stream(label), session_id=label)
        events = [event async for event in iterator]
        assert {event.session_id for event in events} == {label}
        return "".join(event.text for event in events)

    assert await asyncio.gather(collect("a"), collect("b")) == ["a" * 20, "b" * 20]


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_read", [False, True])
async def test_close_failure_does_not_hide_the_original_stream_error(fail_read):
    class Stream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            if fail_read:
                raise ValueError("read failed")
            raise StopAsyncIteration

        async def aclose(self):
            raise RuntimeError("close failed")

    iterator, _ = pump(Stream())
    with pytest.raises(ValueError if fail_read else RuntimeError, match="read failed" if fail_read else "close failed"):
        await anext(iterator)
