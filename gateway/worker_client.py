"""JSONL client for the rind worker (remote-plan/gateway.md §3).

One state machine over two transports (see ``transports.py``).  Requests
correlate by auto-incrementing int ids and time out after 120s with
:class:`WorkerTimeout`.  Events dedup on ``(session_id, sequence)`` within a
connection epoch.  Reconnect runs a fixed order: reconnect + initialize →
resubscribe every known session → ``session/replay(after_cursor=本地 cursor)``
fed to the callback with ``replayed=True`` → resume the live stream.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from agent.runtime.server.protocol import RuntimeMethod

from .transports import build_transport

logger = logging.getLogger(__name__)

WORKER_CAPABILITY = "rind/session-subscriptions"
REQUEST_TIMEOUT_SECONDS = 120.0
RECONNECT_INITIAL_SECONDS = 0.25
RECONNECT_MAX_SECONDS = 4.0

EventCallback = Callable[[dict, bool], Awaitable[None]]
CursorProvider = Callable[[str], int]


class WorkerError(Exception):
    """Worker-facing failure; the pump renders these as one reply line."""


class WorkerTimeout(WorkerError):
    pass


class WorkerConnectionError(WorkerError):
    pass


class WorkerRequestError(WorkerError):
    def __init__(self, method: str, error: dict[str, Any]) -> None:
        super().__init__(f"{method} failed: {error.get('message', error)}")
        self.method = method
        self.error = error


class WorkerClient:
    """Request/response + event multiplexing with reconnect and catch-up."""

    def __init__(
        self,
        url: str,
        token: str | None = None,
        *,
        transport: Any | None = None,
        cursor_provider: CursorProvider | None = None,
    ) -> None:
        self._url = url
        self._transport = transport if transport is not None else build_transport(url, token)
        self._cursor_provider = cursor_provider
        self._callback: EventCallback | None = None
        self._request_ids = iter(range(1, 1 << 62))
        self._pending: dict[int, tuple[asyncio.Future[dict[str, Any]], str]] = {}
        self._sessions: set[str] = set()
        self._events: asyncio.Queue[tuple[dict, bool]] | None = None
        self._reader: asyncio.Task[None] | None = None
        self._consumer: asyncio.Task[None] | None = None
        self._supervisor: asyncio.Task[None] | None = None
        self._stopping = False
        self._up = False
        self._catching_up = False
        self._held: list[tuple[dict, bool]] = []
        self._seen: set[tuple[str, int]] = set()

    @property
    def connected(self) -> bool:
        return self._up and not self._stopping

    def on_event(self, callback: EventCallback) -> None:
        """Register the (async) sink for live and replayed event envelopes."""
        self._callback = callback

    async def start(self) -> None:
        await self._bring_up()
        self._events = asyncio.Queue()
        self._consumer = asyncio.create_task(self._consume_events())
        self._supervisor = asyncio.create_task(self._supervise())

    async def stop(self) -> None:
        self._stopping = True
        self._up = False
        for task in (self._reader, self._consumer, self._supervisor):
            if task is not None:
                task.cancel()
        await self._transport.close()
        self._fail_pending(WorkerConnectionError("worker client stopped"))

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        if not self.connected:
            raise WorkerConnectionError("worker is not connected")
        request_id = next(self._request_ids)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = (future, method)  # method: error responses don't echo it
        frame = {"kind": "request", "request_id": request_id, "method": method, "params": params}
        try:
            await self._transport.write(frame)
        except Exception as exc:
            raise WorkerConnectionError(f"worker write failed: {exc}") from exc
        try:
            result = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError as exc:
            raise WorkerTimeout(f"worker request timed out: {method}") from exc
        finally:
            self._pending.pop(request_id, None)
        return result if isinstance(result, dict) else {}

    async def subscribe(self, session_id: str) -> None:
        if session_id in self._sessions:
            return
        await self.request(RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": session_id})
        self._sessions.add(session_id)

    async def _bring_up(self) -> None:
        delay = RECONNECT_INITIAL_SECONDS
        while True:
            try:
                await self._transport.open()
                break
            except Exception:
                if self._stopping:
                    raise WorkerConnectionError("worker connection failed") from None
                logger.warning(
                    "gateway: worker 连接失败（%s）；%.2fs 后重试——请确认 worker 已启动、地址正确且 token 一致",
                    self._url, delay,
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_SECONDS)
        # The transport is live from here on: bring-up requests need the
        # reader to resolve them, and `connected` must be true to send at all.
        self._up = True
        self._seen.clear()  # sequence is connection state (§3): new epoch
        self._reader = asyncio.create_task(self._read_loop())
        try:
            result = await self.request(RuntimeMethod.INITIALIZE, {})
        except WorkerError:
            await self._teardown()
            raise
        capabilities = result.get("capabilities")
        if not isinstance(capabilities, list) or WORKER_CAPABILITY not in capabilities:
            await self._teardown()
            raise RuntimeError(f"worker 缺少 {WORKER_CAPABILITY} 能力：请先升级 worker（app-server）再启动网关。")

    async def _teardown(self) -> None:
        """Close one connection without ending the client's lifecycle."""
        self._up = False
        reader, self._reader = self._reader, None
        if reader is not None:
            reader.cancel()
        await self._transport.close()
        self._fail_pending(WorkerConnectionError("worker connection lost"))

    async def _supervise(self) -> None:
        while not self._stopping:
            reader = self._reader
            if reader is not None:
                await reader  # returns when the connection drops
            if self._stopping:
                return
            await self._reconnect()

    async def _reconnect(self) -> None:
        delay = RECONNECT_INITIAL_SECONDS
        while not self._stopping:
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)
            try:
                await self._bring_up()
                await self._catch_up()
                logger.info("gateway: worker connection restored")
                return
            except Exception as exc:
                logger.warning("gateway: worker reconnect failed (%s); retrying in %.2fs", exc, delay)

    async def _catch_up(self) -> None:
        """Fixed reconnect order: resubscribe → replay(after_cursor) → live."""
        self._catching_up = True
        try:
            for session_id in sorted(self._sessions):
                await self.request(RuntimeMethod.SESSION_SUBSCRIBE, {"session_id": session_id})
            for session_id in sorted(self._sessions):
                cursor = int(self._cursor_provider(session_id)) if self._cursor_provider else 0
                result = await self.request(
                    RuntimeMethod.SESSION_REPLAY, {"session_id": session_id, "after_cursor": max(0, cursor)}
                )
                assert self._events is not None
                for envelope in result.get("events") or []:
                    self._events.put_nowait((dict(envelope), True))
        finally:
            held, self._held = self._held, []
            self._catching_up = False
            for envelope, replayed in held:
                self._receive_event(envelope, replayed)

    async def _read_loop(self) -> None:
        try:
            while True:
                message = await self._transport.read()
                if message is None:
                    break
                if message.get("kind") == "response":
                    self._resolve_response(message)
                elif message.get("kind") == "event":
                    self._receive_event(message, replayed=False)
        except Exception:
            logger.debug("gateway: worker read loop ended", exc_info=True)
        finally:
            self._up = False
            self._fail_pending(WorkerConnectionError("worker connection lost"))

    def _resolve_response(self, message: dict[str, Any]) -> None:
        entry = self._pending.get(message.get("request_id"))
        if entry is None:
            return
        future, method = entry
        if future.done():
            return
        if "error" in message:
            future.set_exception(WorkerRequestError(method, message["error"]))
        else:
            future.set_result(message.get("result"))

    def _receive_event(self, envelope: dict[str, Any], *, replayed: bool) -> None:
        if self._catching_up:
            self._held.append((envelope, replayed))
            return
        if not replayed:
            key = (str(envelope.get("session_id") or ""), int(envelope.get("sequence") or 0))
            if key in self._seen:
                return
            self._seen.add(key)
        assert self._events is not None
        self._events.put_nowait((envelope, replayed))

    async def _consume_events(self) -> None:
        assert self._events is not None
        while True:
            envelope, replayed = await self._events.get()
            if self._callback is None:
                continue
            try:
                await self._callback(envelope, replayed)
            except Exception:
                logger.exception("gateway: event callback failed")

    def _fail_pending(self, error: WorkerError) -> None:
        pending, self._pending = self._pending, {}
        for future, _method in pending.values():
            if not future.done():
                future.set_exception(error)


__all__ = [
    "WORKER_CAPABILITY",
    "WorkerClient",
    "WorkerConnectionError",
    "WorkerError",
    "WorkerRequestError",
    "WorkerTimeout",
]
