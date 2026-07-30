import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.stream_parser import MessageStreamParser


async def _stream_with_usage():
    yield SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content="hello", tool_calls=None),
            )
        ],
        usage=None,
    )
    yield SimpleNamespace(
        choices=[],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12),
    )


async def _stream_with_tool_input():
    yield SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=0,
                            id="call_1",
                            function=SimpleNamespace(
                                name="write_file",
                                arguments='{"file_path":"notes.txt","content":"',
                            ),
                        )
                    ],
                )
            )
        ],
        usage=None,
    )
    yield SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=0,
                            id=None,
                            function=SimpleNamespace(name=None, arguments="hello"),
                        )
                    ],
                )
            )
        ],
        usage=None,
    )


def test_message_stream_parser_returns_final_usage_chunk() -> None:
    async def _run():
        parts = []

        async def on_content(text):
            parts.append(text)

        content, calls, usage = await MessageStreamParser().consume_async_stream(_stream_with_usage(), on_content)
        assert content == "hello"
        assert calls == []
        assert usage.prompt_tokens == 10
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

        content, calls, usage = await MessageStreamParser().consume_async_stream(
            _stream_with_tool_input(),
            on_content,
            on_tool_input_started_async=on_started,
            on_tool_input_delta_async=on_delta,
            on_tool_input_ended_async=on_ended,
        )

        assert content == ""
        assert usage is None
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


def main() -> int:
    test_message_stream_parser_returns_final_usage_chunk()
    test_message_stream_parser_streams_tool_input_lifecycle()
    print("MessageStreamParser tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
