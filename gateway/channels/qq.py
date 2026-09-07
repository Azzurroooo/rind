"""QQ channel adapter via OneBot v11 reverse WebSocket (gateway.md §8, plan §5.6 P1).

A small WS server endpoint (the repo's ``websockets`` library — no new dep);
NapCat/Lagrange connects out to ``ws://<host>:<ws_port><ws_path>`` and pushes
OneBot v11 events; actions are dispatched over the same socket with ``echo``
id matching like the worker client (§3), and an optional ``access_token``
shared secret is checked from ``Authorization: Bearer`` at handshake.
``websockets`` is lazy-imported so a missing library disables only this
channel with a one-line log (§1).  §8 scope only: events → ``InboundMessage``
(CQ images under ``<uploads>/qq/<date>/``), ``send``, capabilities, config,
start/stop; the chat-kind map is transport state for the send action choice.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import importlib
import json
import logging
import os
import re
import urllib.request
from datetime import datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "qq"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow", "ws_path", "ws_port", "access_token"})
CAPABILITIES = ChannelCapabilities(max_text_length=4500, len_unit="chars", supports_typing=False,
                                   supports_buttons=False, supports_reaction=False, markdown="none")

DEFAULT_WS_PATH, DEFAULT_WS_PORT, BIND_HOST = "/onebot/v11", 8082, "0.0.0.0"
MAX_ATTACHMENT_BYTES, OVERSIZE_NOTICE = 20 * 1024 * 1024, "附件过大（单个上限 20MB），已忽略该附件。"
ECHO_TIMEOUT_SECONDS = 120.0  # mirrors the worker client request timeout (§3)

_CQ_PATTERN = re.compile(r"\[CQ:([a-zA-Z0-9_.\-]+)((?:,[^\[\]]*)*)\]")
_CQ_UNESCAPES = (("&#44;", ","), ("&#91;", "["), ("&#93;", "]"), ("&amp;", "&"))
_MEDIA_SEGMENTS = {"image": "image", "record": "audio", "video": "video", "file": "document"}
_KIND_META = {"image": ("image/jpeg", ".jpg"), "audio": ("audio/amr", ".amr"), "video": ("video/mp4", ".mp4")}
_SEGMENT_BY_KIND = {"image": "image", "audio": "record", "video": "video", "document": "file"}


def _load_sdk() -> Any:
    """Import websockets (server side); ImportError text names the fix (§1 log)."""
    try:
        return (importlib.import_module("websockets.asyncio.server"),
                importlib.import_module("websockets.http11"),
                importlib.import_module("websockets.datastructures"))
    except ImportError as exc:
        raise ImportError(f"channel 'qq' requires websockets>=12 ({exc}); install it to enable the channel") from exc


def _cq_unescape(value: str) -> str:
    for entity, char in _CQ_UNESCAPES:
        value = value.replace(entity, char)
    return value


def _segments_of(message: Any) -> list[tuple[str, dict[str, str]]]:
    """OneBot message (CQ string or segment array) → [(kind, params)]."""
    if isinstance(message, list):
        return [(str(seg.get("type") or ""), dict(seg.get("data") or {}))
                for seg in message if isinstance(seg, dict)]
    if not isinstance(message, str):
        return []
    segments: list[tuple[str, dict[str, str]]] = []
    cursor = 0
    for match in _CQ_PATTERN.finditer(message):
        if match.start() > cursor:
            segments.append(("text", {"text": _cq_unescape(message[cursor:match.start()])}))
        params = {_cq_unescape(key.strip()): _cq_unescape(value.strip())
                  for key, separator, value in
                  (part.partition("=") for part in match.group(2).split(",")) if separator}
        segments.append((_cq_unescape(match.group(1)), params))
        cursor = match.end()
    if cursor < len(message):
        segments.append(("text", {"text": _cq_unescape(message[cursor:])}))
    return segments


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "").replace("\\", "/")).strip()).strip("._")
    return name or fallback


def _as_id(value: str) -> Any:
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def _url_read(request: Any) -> bytes:
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


class QQChannel:
    """OneBot v11 adapter; ``sink`` is the pump: we only ``await sink.inbound(...)``."""
    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, uploads_root: Path, ws_path: str = DEFAULT_WS_PATH,
                 ws_port: int = DEFAULT_WS_PORT, access_token: str = "") -> None:
        self._ws_path, self._ws_port = ws_path, int(ws_port)
        self._access_token, self._uploads_root = access_token, Path(uploads_root)
        self._sink = self._server = self._conn = self._reject = None
        self._sdk: tuple[Any, ...] | None = None
        self._send_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._echo_ids = iter(range(1, 1 << 62))
        self._chat_kinds: dict[str, str] = {}  # chat_id → dm/group (send action choice)

    async def start(self, sink: Any) -> None:
        self._sink = sink
        server_mod, http11, datastructures = self._sdk or _load_sdk()
        self._sdk = (server_mod, http11, datastructures)
        self._reject = lambda status: http11.Response(status.value, status.phrase, datastructures.Headers(), b"")
        self._server = await server_mod.serve(self._handle, BIND_HOST, self._ws_port,
                                              process_request=self._process_request)
        logger.info("gateway qq: onebot reverse-ws endpoint on ws://%s:%s%s", BIND_HOST, self._ws_port, self._ws_path)

    def _process_request(self, connection: Any, request: Any) -> Any:
        """Handshake gate: exact path + optional Authorization bearer secret."""
        if urlsplit(str(getattr(request, "path", "") or "")).path != self._ws_path:
            return self._reject(HTTPStatus.NOT_FOUND)
        if self._access_token:
            scheme, _, credentials = str(getattr(request, "headers", {}).get("Authorization", "")).partition(" ")
            if scheme.lower() != "bearer" or not hmac.compare_digest(credentials.strip(), self._access_token):
                return self._reject(HTTPStatus.UNAUTHORIZED)
        return None

    async def stop(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.close()
            with contextlib.suppress(Exception):
                await server.wait_closed()
        conn, self._conn = self._conn, None
        if conn is not None:
            with contextlib.suppress(Exception):
                await conn.close()
        self._fail_pending()

    async def _handle(self, websocket: Any) -> None:
        self._conn = websocket
        try:
            async for raw in websocket:
                try:
                    frame = json.loads(raw)
                except (TypeError, ValueError) as exc:
                    logger.warning("gateway qq: frame is not JSON: %s", exc)
                    continue
                if not isinstance(frame, dict):
                    continue
                if frame.get("post_type") == "message":  # detached: the read loop must stay
                    asyncio.create_task(self._process_event(frame))  # free to resolve echo responses
                elif frame.get("echo") is not None:  # action response: resolve the pending future
                    future = self._pending.pop(str(frame.get("echo")), None)
                    if future is not None and not future.done():
                        future.set_result(frame["data"] if isinstance(frame.get("data"), dict) else {})
        except Exception as exc:  # ConnectionClosed & friends: connection dropped
            logger.debug("gateway qq: onebot connection ended: %s", exc)
        finally:
            if self._conn is websocket:
                self._conn = None
            self._fail_pending()

    async def _process_event(self, frame: dict[str, Any]) -> None:
        try:
            inbound = await self._normalize_event(frame)
        except Exception as exc:
            logger.warning("gateway qq: event normalize failed: %s", exc)
            return
        if inbound is not None and self._sink is not None:
            await self._sink.inbound(inbound)

    def _fail_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ConnectionError("onebot connection lost"))
        self._pending.clear()

    async def _normalize_event(self, event: dict[str, Any]) -> InboundMessage | None:
        sender_id = str(event.get("user_id") or "")
        message_ref = str(event.get("message_id") or "")
        is_group = event.get("message_type") == "group"
        chat_id = str(event.get("group_id") or "") if is_group else sender_id
        if not chat_id or not sender_id or not message_ref:
            return None
        self._chat_kinds[chat_id] = "group" if is_group else "dm"  # transport state: send action choice
        segments = _segments_of(event.get("message"))
        media = [(kind, params) for kind, params in segments if kind in _MEDIA_SEGMENTS]
        sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
        return InboundMessage(
            channel=CHANNEL_ID, chat_id=chat_id, chat_type="group" if is_group else "dm", sender_id=sender_id,
            sender_name=str(sender.get("nickname") or sender_id),
            thread_id=None,  # OneBot replies are CQ "reply" segments; threading stays P2
            text="".join(params.get("text", "") for kind, params in segments if kind == "text"),
            attachments=await self._collect_attachments(media, message_ref, chat_id),
            message_ref=message_ref,
        )

    async def _collect_attachments(self, media: list[tuple[str, dict[str, str]]], message_ref: str,
                                   chat_id: str) -> tuple[Attachment, ...]:
        if not media:
            return ()
        directory, saved = self._attachment_dir(), []
        for position, (segment, params) in enumerate(media, start=1):
            kind = _MEDIA_SEGMENTS[segment]
            content_type, ext = _KIND_META.get(kind, ("application/octet-stream", ".bin"))
            source = str(params.get("url") or "").strip() or str(params.get("file") or "").strip()
            if source and not (source.startswith(("http://", "https://", "file:")) or "/" in source or "\\" in source):
                result = await self._send_action("get_image", {"file": source})  # resolves NapCat .image ids
                source = str((result or {}).get("url") or (result or {}).get("file") or "")
            if not source:
                logger.warning("gateway qq: %s segment has no url/file; skipping", segment)
                continue
            try:
                data = await self._fetch_bytes(source)
            except Exception as exc:
                logger.warning("gateway qq: attachment %s download failed: %s", source, exc)
                continue
            if len(data) > MAX_ATTACHMENT_BYTES:  # §8: one-line notice instead of the file
                logger.info("gateway qq: ignored attachment over 20MB from chat %s", chat_id)
                with contextlib.suppress(Exception):
                    await self.send(SendTarget(chat_id=chat_id), OutboundPayload(text=OVERSIZE_NOTICE))
                continue
            path = directory / _safe_filename(params.get("file"), f"{message_ref}-{position}{ext}")
            path.write_bytes(data)
            saved.append(Attachment(path=path, content_type=content_type, kind=kind))
        return tuple(saved)

    async def _fetch_bytes(self, source: str) -> bytes:
        if source.startswith(("http://", "https://")):
            return await asyncio.to_thread(_url_read, urllib.request.Request(source))
        return await asyncio.to_thread(Path(source.removeprefix("file://")).read_bytes)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        if self._conn is None:
            logger.warning("gateway qq: no onebot connection; dropping payload")
            return
        try:
            segments = [{"type": "text", "data": {"text": payload.text}}] if payload.text else []
            segments.extend({"type": _SEGMENT_BY_KIND[attachment.kind], "data": {"file": attachment.path.as_uri()}}
                            for attachment in payload.attachments)
            if not segments:
                return
            action, key = (("send_private_msg", "user_id") if self._chat_kinds.get(target.chat_id, "group") == "dm"
                           else ("send_group_msg", "group_id"))
            await self._send_action(action, {key: _as_id(target.chat_id), "message": segments})
        except Exception as exc:
            logger.warning("gateway qq: send to chat %s failed: %s", target.chat_id, exc)

    async def _send_action(self, action: str, params: dict[str, Any]) -> dict[str, Any] | None:
        conn = self._conn
        if conn is None:
            logger.warning("gateway qq: no onebot connection; dropping action %s", action)
            return None
        echo = f"rind-{next(self._echo_ids)}"
        future = asyncio.get_running_loop().create_future()
        self._pending[echo] = future
        try:
            async with self._send_lock:
                await conn.send(json.dumps({"action": action, "params": params, "echo": echo}))
            return await asyncio.wait_for(future, ECHO_TIMEOUT_SECONDS)
        finally:
            self._pending.pop(echo, None)


def build_channel(config: ChannelConfig, uploads_root: Path) -> QQChannel:
    """Registry entry point: validates config, fails fast when websockets missing."""
    extra = config.extra
    ws_path = str(extra.get("ws_path", "") or "").strip() or DEFAULT_WS_PATH
    if not ws_path.startswith("/"):
        raise ValueError("channel 'qq' ws_path must start with '/' (channels.qq.ws_path)")
    ws_port = extra.get("ws_port")
    if ws_port is not None and (isinstance(ws_port, bool) or not isinstance(ws_port, int)):
        raise ValueError("channel 'qq' ws_port must be an integer port in [1, 65535]")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return QQChannel(ws_path=ws_path, ws_port=int(ws_port or DEFAULT_WS_PORT),
                     access_token=str(extra.get("access_token", "") or "").strip(),
                     uploads_root=Path(uploads_root))


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "QQChannel", "build_channel"]
