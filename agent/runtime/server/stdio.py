"""JSONL stdin/stdout transport for the runtime dispatcher."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import json
import signal
import sys
import threading
from typing import Any

from agent.runtime.server.dispatcher import RuntimeDispatcher
from agent.runtime.server.protocol import error_message, validate_request


def _schedule_ingest(loop: asyncio.AbstractEventLoop, ingest: Callable, *args: Any):
    """The stdin pump is a daemon thread: once the loop has closed the process
    is already exiting, so drop the delivery instead of raising."""
    if loop.is_closed():
        return None
    coro = ingest(*args)
    try:
        return asyncio.run_coroutine_threadsafe(coro, loop)
    except RuntimeError:
        coro.close()
        return None


class JsonlWriter:
    def __init__(self):
        self._lock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        async with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()


def configure_utf8_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def configure_stdio_server_signals() -> None:
    signal.signal(signal.SIGINT, signal.SIG_IGN)


class StdioRuntimeServer:
    """Own the stdin pump and forward validated JSONL requests."""

    worker_mode = True

    def __init__(self, worker, debug=False, *, background_list=None, background_output=None, goal_enabled=True):
        self._writer = JsonlWriter()
        self._dispatcher = RuntimeDispatcher(
            worker, debug=debug, writer=self._writer,
            background_list=background_list, background_output=background_output,
            goal_enabled=goal_enabled,
        )

    async def run(self) -> int:
        loop = asyncio.get_running_loop()

        def pump() -> None:
            while True:
                line = sys.stdin.readline()
                if not line:
                    break
                future = _schedule_ingest(loop, self._ingest_line, line)
                if future is None:
                    return
                future.result()
            _schedule_ingest(loop, self._dispatcher.submit, None)

        threading.Thread(target=pump, name="rind-stdin-pump", daemon=True).start()
        try:
            return await self._dispatcher.serve()
        finally:
            self._dispatcher.close()

    async def _ingest_line(self, line: str) -> None:
        try:
            request = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            await self._writer.send(error_message({}, "Invalid JSON request.", "ParseError"))
            return
        if not isinstance(request, dict):
            await self._writer.send(error_message({}, "Request must be an object.", "ParseError"))
            return
        error = validate_request(request)
        if error is not None:
            await self._writer.send(error_message(request, error, "InvalidRequest"))
            return
        await self._dispatcher.submit(request)
