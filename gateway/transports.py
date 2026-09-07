"""Worker client transports: one read/write coroutine pair per carrier.

WS (``ws://host:port``, optionally carrying ``?token=``) and stdio
(``python main.py app-server --stdio``) behave identically; this is the only
place they differ, per remote-plan/gateway.md §3.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _parse(raw: str | bytes) -> dict[str, Any] | None:
    try:
        message = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    return message if isinstance(message, dict) else None


def _serialize(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class _WebSocketTransport:
    def __init__(self, url: str) -> None:
        self._url = url
        self._connection = None

    async def open(self) -> None:
        self._connection = await connect(self._url, max_size=8 * 1024 * 1024, open_timeout=10)

    async def read(self) -> dict[str, Any] | None:
        while self._connection is not None:
            try:
                raw = await self._connection.recv()
            except (ConnectionClosed, OSError):
                return None
            message = _parse(raw)
            if message is not None:
                return message

    async def write(self, payload: dict[str, Any]) -> None:
        await self._connection.send(_serialize(payload))

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None


class _StdioTransport:
    """Spawns the app-server subprocess; identical semantics to WebSocket."""

    def __init__(self, command: list[str] | None = None) -> None:
        self._command = command or [sys.executable, str(PROJECT_ROOT / "main.py"), "app-server", "--stdio"]
        self._process: asyncio.subprocess.Process | None = None

    async def open(self) -> None:
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
        )

    async def read(self) -> dict[str, Any] | None:
        while self._process is not None and self._process.stdout is not None:
            raw = await self._process.stdout.readline()
            if not raw:
                return None
            message = _parse(raw)
            if message is not None:
                return message

    async def write(self, payload: dict[str, Any]) -> None:
        assert self._process is not None and self._process.stdin is not None
        self._process.stdin.write((_serialize(payload) + "\n").encode("utf-8"))
        await self._process.stdin.drain()

    async def close(self) -> None:
        if self._process is not None and self._process.returncode is None:
            self._process.terminate()
            await self._process.wait()
        self._process = None


def build_transport(url: str, token: str | None) -> Any:
    """``stdio`` spawns the worker subprocess; anything else is a WS URL."""
    if url == "stdio":
        return _StdioTransport()
    if token and "token=" not in url:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}token={token}"
    return _WebSocketTransport(url)
