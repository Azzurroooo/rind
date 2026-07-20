import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.message_stream_parser import MessageStreamParser


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


def main() -> int:
    test_message_stream_parser_returns_final_usage_chunk()
    print("MessageStreamParser tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
