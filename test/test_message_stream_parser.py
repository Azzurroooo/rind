import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.models import ModelStreamEvent, ModelUsage
from agent.runtime.core.stream_parser import MessageStreamParser


async def _ignore(_text):
    return None


async def _consume(stream, on_content=_ignore, **callbacks):
    return await MessageStreamParser().consume_async_stream(stream(), on_content, **callbacks)


async def _stream_with_usage():
    yield ModelStreamEvent("text_delta", text="hello")
    yield ModelStreamEvent("usage", usage=ModelUsage(input_tokens=10, output_tokens=2))
    yield ModelStreamEvent("completed", stop_reason="stop")


async def _stream_with_tool_input():
    yield ModelStreamEvent("tool_start", tool_call_id="call_1", tool_name="write_file")
    yield ModelStreamEvent("tool_arguments_delta", tool_call_id="call_1", tool_name="write_file", arguments='{"file_path":"notes.txt","content":"')
    yield ModelStreamEvent("tool_arguments_delta", tool_call_id="call_1", tool_name="write_file", arguments="hello")
    yield ModelStreamEvent("completed", stop_reason="tool_calls")


def test_message_stream_parser_returns_final_usage_chunk() -> None:
    async def _run():
        parts = []

        async def on_content(text):
            parts.append(text)

        content, calls, usage, reasoning_content, finish_reason = await MessageStreamParser().consume_async_stream(
            _stream_with_usage(), on_content
        )
        assert content == "hello"
        assert calls == []
        assert usage.input_tokens == 10
        assert reasoning_content is None
        assert finish_reason == "stop"
        assert parts == ["hello"]

    asyncio.run(_run())


def test_message_stream_parser_streams_tool_input_lifecycle() -> None:
    async def _run():
        events = []

        async def on_content(_text):
            raise AssertionError("tool input stream should not produce assistant text")

        async def on_started(call_id, name):
            events.append(("started", call_id, name))

        async def on_delta(call_id, name, delta):
            events.append(("delta", call_id, name, delta))

        async def on_ended(call_id, name):
            events.append(("ended", call_id, name))

        content, calls, usage, reasoning_content, _finish_reason = await MessageStreamParser().consume_async_stream(
            _stream_with_tool_input(),
            on_content,
            on_tool_input_started_async=on_started,
            on_tool_input_delta_async=on_delta,
            on_tool_input_ended_async=on_ended,
        )

        assert content == ""
        assert usage is None
        assert reasoning_content is None
        assert [(event[0], event[1], event[2]) for event in events] == [
            ("started", "call_1", "write_file"),
            ("delta", "call_1", "write_file"),
            ("delta", "call_1", "write_file"),
            ("ended", "call_1", "write_file"),
        ]
        assert events[1][3] == '{"file_path":"notes.txt","content":"'
        assert events[2][3] == "hello"
        assert calls[0].raw_args == '{"file_path":"notes.txt","content":"hello'

    asyncio.run(_run())


def test_message_stream_parser_reassembles_reasoning_content() -> None:
    async def stream():
        yield ModelStreamEvent("reasoning_delta", reasoning="first ")
        yield ModelStreamEvent("text_delta", text="answer")
        yield ModelStreamEvent("reasoning_delta", reasoning="second")

    content, calls, usage, reasoning_content, _finish_reason = asyncio.run(_consume(stream))
    assert content == "answer"
    assert calls == []
    assert usage is None
    assert reasoning_content == "first second"


def test_message_stream_parser_preserves_empty_reasoning_content() -> None:
    async def stream():
        yield ModelStreamEvent("reasoning_delta", reasoning="")
        yield ModelStreamEvent("completed", stop_reason="stop")

    _content, _calls, _usage, reasoning_content, _finish_reason = asyncio.run(_consume(stream))
    assert reasoning_content is None


def test_message_stream_parser_ends_tools_that_never_emit_tool_end() -> None:
    async def stream():
        yield ModelStreamEvent("tool_start", tool_call_id="call_1", tool_name="bash")
        yield ModelStreamEvent("tool_arguments_delta", tool_call_id="call_1", tool_name="bash", arguments="{}")
        yield ModelStreamEvent("completed", stop_reason="tool_calls")

    events = []

    async def on_ended(call_id, name):
        events.append((call_id, name))

    asyncio.run(_consume(stream, on_tool_input_ended_async=on_ended))
    assert events == [("call_1", "bash")]
