"""WebSocket transport for a long-lived Rind worker."""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import secrets
import sys
import time
from collections.abc import Callable
from http import HTTPStatus
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from agent.runtime.server.protocol import error_message, validate_request
from agent.runtime.server.stdio import WorkerStdioRuntimeServer

AUTH_CLOSE_CODE = 4401


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
        server_token: str | None = None,
        ticket_ttl_seconds: float = 60.0,
        ticket_capacity: int = 10_000,
    ) -> None:
        self._worker = worker
        self._debug = debug
        self._host = host
        self._port = port
        self._background_list = background_list
        self._background_output = background_output
        self._goal_enabled = goal_enabled
        self._server_token = str(server_token or "").strip()
        self._ticket_ttl_seconds = ticket_ttl_seconds
        self._ticket_capacity = ticket_capacity
        self._tickets: dict[str, float] = {}

    async def run(self) -> int:
        if not self._server_token and not _is_loopback_host(self._host):
            print(
                f"Refusing to bind ws://{self._host}:{self._port} without a server token; "
                "set serverToken in settings.json or RIND_SERVER_TOKEN.",
                file=sys.stderr,
            )
            return 2
        async with self._serve():
            print(f"Rind WebSocket worker listening on ws://{self._host}:{self._port}")
            try:
                await asyncio.Future()
            finally:
                await self._worker.close()
        return 0

    def _serve(self):
        return serve(
            self._handle_connection,
            self._host,
            self._port,
            max_size=8 * 1024 * 1024,
            process_request=self._process_request,
        )

    async def _process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        path = urlsplit(request.path).path
        if path == "/healthz":
            return _json_response({"ok": True})
        if path == "/ticket":
            if not self._server_token:
                return _json_response(None, HTTPStatus.NOT_FOUND)
            if self._bearer_matches(request.headers):
                return _json_response({"ticket": self._issue_ticket()})
            return _json_response(None, HTTPStatus.UNAUTHORIZED)
        return None

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        if not await self._authorize(websocket):
            return
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
            server.close()
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

    async def _authorize(self, websocket: ServerConnection) -> bool:
        if not self._server_token:
            return True
        request = websocket.request
        headers = request.headers if request is not None else Headers()
        if not self._origin_allowed(headers):
            await websocket.close(code=AUTH_CLOSE_CODE)
            return False
        path = request.path if request is not None else ""
        query = parse_qs(urlsplit(path).query)
        tokens = query.get("token")
        if tokens and _safe_equals(tokens[0], self._server_token):
            return True
        tickets = query.get("ticket")
        if tickets and self._consume_ticket(tickets[0]):
            return True
        await websocket.close(code=AUTH_CLOSE_CODE)
        return False

    def _origin_allowed(self, headers: Headers) -> bool:
        origin = headers.get("Origin")
        if not origin:
            return True
        origin_host = urlsplit(origin).hostname
        host = urlsplit(f"//{headers.get('Host', '')}").hostname
        return bool(origin_host and host) and origin_host.lower() == host.lower()

    def _bearer_matches(self, headers: Headers) -> bool:
        scheme, _, credentials = headers.get("Authorization", "").partition(" ")
        return scheme.lower() == "bearer" and _safe_equals(credentials.strip(), self._server_token)

    def _issue_ticket(self) -> str:
        self._drop_expired_tickets()
        while len(self._tickets) >= self._ticket_capacity:
            oldest = min(self._tickets.items(), key=lambda item: item[1])[0]
            del self._tickets[oldest]
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = time.monotonic() + self._ticket_ttl_seconds
        return ticket

    def _consume_ticket(self, ticket: str) -> bool:
        self._drop_expired_tickets()
        deadline = self._tickets.pop(ticket, None)
        return deadline is not None and deadline > time.monotonic()

    def _drop_expired_tickets(self) -> None:
        now = time.monotonic()
        for ticket, deadline in list(self._tickets.items()):
            if deadline <= now:
                del self._tickets[ticket]


def _safe_equals(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def _is_loopback_host(host: str) -> bool:
    candidate = (host or "").strip().strip("[]").lower()
    if candidate == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


def _json_response(payload: dict[str, Any] | None, status: HTTPStatus = HTTPStatus.OK) -> Response:
    body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = Headers({"Content-Type": "application/json", "Content-Length": str(len(body))})
    return Response(status.value, status.phrase, headers, body)


__all__ = ["WebRuntimeServer", "WebSocketWriter"]
