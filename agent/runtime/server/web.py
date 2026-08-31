"""WebSocket transport for a long-lived Rind worker."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from agent.runtime.server.protocol import error_message, validate_request
from agent.runtime.server.stdio import WorkerStdioRuntimeServer


class WebSocketWriter:
    """Best-effort writer that lets worker tasks outlive a closed browser."""

    def __init__(self, websocket: ServerConnection) -> None:
        self._websocket = websocket
        self._lock = asyncio.Lock()
        self._closed = False

    async def send(self, payload: dict[str, Any]) -> None:
        if self._closed:
            return
        try:
            async with self._lock:
                if not self._closed:
                    await self._websocket.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        except (ConnectionClosed, RuntimeError):
            self._closed = True

    def close(self) -> None:
        self._closed = True


class WebRuntimeServer:
    """Keep one worker alive while browser connections come and go."""

    worker_mode = True
    network_mode = True

    def __init__(
        self,
        worker,
        debug: bool = False,
        *,
        host: str = "127.0.0.1",
        port: int = 8765,
        background_list: Callable[[str], Any] | None = None,
        background_output: Callable[..., Any] | None = None,
        goal_enabled: bool = True,
    ) -> None:
        self._worker = worker
        self._debug = debug
        self._host = host
        self._port = port
        self._background_list = background_list
        self._background_output = background_output
        self._goal_enabled = goal_enabled

    async def run(self) -> int:
        async with serve(self._handle_connection, self._host, self._port, max_size=8 * 1024 * 1024):
            print(f"Rind WebSocket worker listening on ws://{self._host}:{self._port}")
            try:
                await asyncio.Future()
            finally:
                await self._worker.close()
        return 0

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        writer = WebSocketWriter(websocket)
        server = WorkerStdioRuntimeServer(
            self._worker,
            debug=self._debug,
            background_list=self._background_list,
            background_output=self._background_output,
            goal_enabled=self._goal_enabled,
            writer=writer,
        )
        try:
            async for raw_message in websocket:
                request = self._parse_request(raw_message, writer)
                if request is None:
                    continue
                if request.get("method") == "initialize":
                    await server.dispatch(request)
                else:
                    server.schedule(request)
        except ConnectionClosed:
            pass
        finally:
            writer.close()

    @staticmethod
    def _parse_request(raw_message: str | bytes, writer: WebSocketWriter) -> dict[str, Any] | None:
        try:
            request = json.loads(raw_message)
        except (TypeError, json.JSONDecodeError):
            asyncio.create_task(writer.send(error_message({}, "Invalid JSON request.", "ParseError")))
            return None
        if not isinstance(request, dict):
            asyncio.create_task(writer.send(error_message({}, "WebSocket request must be an object.", "ParseError")))
            return None
        request_error = validate_request(request)
        if request_error is not None:
            asyncio.create_task(writer.send(error_message(request, request_error, "InvalidRequest")))
            return None
        return request


__all__ = ["WebRuntimeServer", "WebSocketWriter"]
