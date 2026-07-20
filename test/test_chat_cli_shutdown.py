import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.interfaces.cli.chat_cli import ChatCLI


class ClosableEventStream:
    def __init__(self):
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def aclose(self):
        self.closed = True


class InterruptibleEventStream:
    def __init__(self, token):
        self._token = token
        self.started = asyncio.Event()
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.started.set()
        await self._token.wait()
        raise StopAsyncIteration

    async def aclose(self):
        self.closed = True


class FakeRuntime:
    def __init__(self):
        self.stream = ClosableEventStream()
        self.received_token = None

    def run_turn(self, query=None, cancellation_token=None):
        self.received_token = cancellation_token
        return self.stream


class InterruptibleRuntime:
    def __init__(self):
        self.stream = None
        self.received_token = None

    def run_turn(self, query=None, cancellation_token=None):
        self.received_token = cancellation_token
        self.stream = InterruptibleEventStream(cancellation_token)
        return self.stream


class InterruptibleSlashRuntime:
    def __init__(self):
        self.received_token = None

    async def compact_context(self, reason="manual", cancellation_token=None):
        self.received_token = cancellation_token
        await cancellation_token.wait()
        return {
            "id": "compact_cancelled",
            "source": {
                "message_start_index": 0,
                "message_end_index_exclusive": 0,
                "tool_call_ids": [],
            },
        }


class FakeSession:
    pass


class InterruptingLoop:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.task = None
        self._interrupted = False

    def create_task(self, awaitable):
        self.task = self.loop.create_task(awaitable)
        return self.task

    def run_until_complete(self, awaitable):
        if not self._interrupted and self.task is not None:
            self._interrupted = True
            self.loop.run_until_complete(asyncio.sleep(0))
            raise KeyboardInterrupt
        return self.loop.run_until_complete(awaitable)

    def is_closed(self):
        return self.loop.is_closed()

    def close(self):
        self.loop.close()


async def _run_turn_async_closes_event_stream_and_passes_token() -> None:
    runtime = FakeRuntime()
    cli = ChatCLI(runtime=runtime, session=FakeSession())

    await cli._run_turn_async("hello")

    if runtime.stream.closed is not True:
        raise AssertionError("Expected runtime event stream to be closed")
    if runtime.received_token is None:
        raise AssertionError("Expected cancellation token to be passed to runtime")


def test_run_turn_async_closes_event_stream_and_passes_token() -> None:
    asyncio.run(_run_turn_async_closes_event_stream_and_passes_token())


def test_shutdown_loop_cancels_pending_tasks() -> None:
    loop = asyncio.new_event_loop()
    cli = ChatCLI(runtime=FakeRuntime(), session=FakeSession())

    async def _forever():
        await asyncio.Event().wait()

    try:
        task = loop.create_task(_forever())
        cli._shutdown_loop(loop)
    finally:
        if not loop.is_closed():
            loop.close()

    if not task.cancelled():
        raise AssertionError("Expected pending task to be cancelled during shutdown")
    if not loop.is_closed():
        raise AssertionError("Expected shutdown helper to close the event loop")


def test_run_turn_blocking_cancels_and_closes_stream_on_interrupt() -> None:
    runtime = InterruptibleRuntime()
    cli = ChatCLI(runtime=runtime, session=FakeSession())
    loop = InterruptingLoop()
    cli._event_loop = loop

    try:
        try:
            cli._run_turn_blocking("hello")
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("Expected interrupt to propagate after cleanup")

        if runtime.received_token is None or not runtime.received_token.is_cancelled:
            raise AssertionError("Expected active turn cancellation token to be cancelled")
        if runtime.stream is None or runtime.stream.closed is not True:
            raise AssertionError("Expected interrupted runtime stream to be closed")
        if loop.task is None or not loop.task.done():
            raise AssertionError("Expected interrupted turn task to settle")
    finally:
        if not loop.is_closed():
            loop.close()


def test_run_slash_command_blocking_cancels_and_settles_on_interrupt() -> None:
    runtime = InterruptibleSlashRuntime()
    cli = ChatCLI(runtime=runtime, session=FakeSession())
    loop = InterruptingLoop()
    cli._event_loop = loop

    try:
        try:
            cli._run_slash_command_blocking("/compact")
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("Expected interrupt to propagate after slash command cleanup")

        if runtime.received_token is None or not runtime.received_token.is_cancelled:
            raise AssertionError("Expected slash command cancellation token to be cancelled")
        if loop.task is None or not loop.task.done():
            raise AssertionError("Expected interrupted slash command task to settle")
    finally:
        if not loop.is_closed():
            loop.close()


def main() -> int:
    test_run_turn_async_closes_event_stream_and_passes_token()
    test_shutdown_loop_cancels_pending_tasks()
    test_run_turn_blocking_cancels_and_closes_stream_on_interrupt()
    test_run_slash_command_blocking_cancels_and_settles_on_interrupt()
    print("ChatCLI shutdown tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
