"""DingTalk channel adapter via Stream Mode (gateway.md §8, plan §5.6 P1).

Transport: the official ``dingtalk-stream`` SDK keeps a WebSocket to DingTalk
open (零公网回调); bot messages arrive as CALLBACK_TAG callbacks and replies
go out through the robot oapi send APIs (groupMessages / oToMessages) over the
SDK's authenticated client.  Optional dep lazy-imported in
:func:`build_channel`/:meth:`DingTalkChannel.start`; a missing SDK disables
only this channel with a one-line log (§1).  The SDK runs its own loop/thread,
so callbacks hand off to the gateway loop via ``run_coroutine_threadsafe``.

§8 scope and nothing else: bot callback → ``InboundMessage`` (``downloadUrl``
media persisted under ``<uploads>/dingtalk/<date>/``), ``send``, capability/
config constants, start/stop.  Session logic, retries, chunking, auth and
persistence live in the pump/core.  The in-memory dm-sender map (chat_id →
staffId, learned from inbound) is transport state for choosing the oapi send
API, not session state.  Outbound attachments are dropped with one log line —
robot file sends need the media-upload API, deferred with the P2 backlog.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import inspect
import json
import logging
import os
import re
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "dingtalk"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow", "client_id", "client_secret"})

CAPABILITIES = ChannelCapabilities(
    max_text_length=5000,
    len_unit="chars",
    supports_typing=False,
    supports_buttons=False,
    supports_reaction=False,
    markdown="subset",  # sampleMarkdown is native — send chunker output as-is
)

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"
GROUP_SEND_API = "/v1.0/robot/groupMessages/send"
DIRECT_SEND_API = "/v1.0/robot/oToMessages/send"  # 1:1 (conversationType "1")
MSG_KEY = "sampleMarkdown"  # markdown subset natively rendered by the robot
TITLE_MAX_CHARS = 40
_KIND_BY_MEDIA_TYPE = {"picture": "image", "image": "image", "audio": "audio", "video": "video"}
_KIND_EXT = {"image": ".jpg", "audio": ".audio", "video": ".mp4", "document": ".bin"}
_KIND_CONTENT_TYPE = {"image": "image/jpeg", "audio": "audio/mpeg", "video": "video/mp4"}


def _load_sdk() -> Any:
    """Import dingtalk-stream on first use; ImportError text names the fix (§1 log)."""
    try:
        return importlib.import_module("dingtalk_stream")
    except ImportError as exc:
        raise ImportError(
            f"channel 'dingtalk' requires dingtalk-stream>=0.24 ({exc}); install it to enable the channel"
        ) from exc


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "")).strip()).strip("._")
    return name or fallback


def _title_of(text: str) -> str:
    first_line = text.strip().splitlines()[0].strip() if text.strip() else ""
    return first_line[:TITLE_MAX_CHARS]


class DingTalkChannel:
    """Stream Mode adapter; ``start(sink)`` registers the bot handler and runs
    the SDK client on its own thread.  ``sink`` is the pump — the adapter's
    only outbound-to-core call is ``await sink.inbound(InboundMessage)``."""

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, client_id: str, client_secret: str, uploads_root: Path) -> None:
        self._client_id, self._client_secret = client_id, client_secret
        self._uploads_root = Path(uploads_root)
        self._sink: Any = None
        self._sdk: Any = None
        self._stream_client: Any = None
        self._chatbot: Any = None  # authenticated oapi client for robot sends
        self._task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._dm_senders: dict[str, str] = {}  # chat_id → staffId (dm target resolution)

    # --- lifecycle -----------------------------------------------------------

    async def start(self, sink: Any) -> None:
        self._sink = sink
        sdk = self._sdk or _load_sdk()
        self._sdk = sdk
        self._loop = asyncio.get_running_loop()
        credential = sdk.Credential(self._client_id, self._client_secret)
        self._stream_client = sdk.DingTalkStreamClient(credential)
        self._chatbot = sdk.ChatBotClient(credential)
        self._stream_client.register_callback_handler(sdk.chatbot_bot_type, self)
        self._task = self._loop.create_task(asyncio.to_thread(self._stream_client.start), name="dingtalk-stream")
        logger.info("gateway dingtalk: stream mode client starting")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        stream_client, self._stream_client = self._stream_client, None
        for name in ("stop", "close"):  # best effort; the SDK exposes stop on newer versions
            method = getattr(stream_client, name, None) if stream_client is not None else None
            if callable(method):
                with contextlib.suppress(Exception):
                    result = method()
                    if inspect.isawaitable(result):
                        await result
                break
        self._chatbot = None

    # --- inbound: CALLBACK_TAG callback → InboundMessage (SDK thread) ------------

    async def process(self, callback: Any) -> None:
        """Registered as the SDK callback handler (dingtalk_stream.chatbot_bot_type)."""
        data = getattr(callback, "data", None)
        message = self._normalize_callback(data if isinstance(data, dict) else {})
        if message is not None and self._loop is not None:
            future = asyncio.run_coroutine_threadsafe(self._deliver(message), self._loop)
            await asyncio.wrap_future(future)

    async def _deliver(self, message: InboundMessage) -> None:
        if self._sink is not None:
            await self._sink.inbound(message)

    def _normalize_callback(self, data: dict[str, Any]) -> InboundMessage | None:
        chat_id = str(data.get("conversationId") or "")
        sender_id = str(data.get("senderStaffId") or data.get("senderId") or "")
        message_ref = str(data.get("msgId") or "")
        if not chat_id or not sender_id or not message_ref:
            return None
        chat_type = "dm" if str(data.get("conversationType") or "") == "1" else "group"
        if chat_type == "dm":
            self._dm_senders[chat_id] = sender_id  # transport state: oToMessages target
        media = data.get("content") if isinstance(data.get("content"), dict) else {}
        text_block = data.get("text") if isinstance(data.get("text"), dict) else {}
        text = str(text_block.get("content") or "")
        if not text and isinstance(data.get("text"), str):
            text = str(data.get("text"))
        return InboundMessage(
            channel=CHANNEL_ID,
            chat_id=chat_id,
            chat_type=chat_type,
            sender_id=sender_id,
            sender_name=str(data.get("senderNick") or sender_id),
            thread_id=None,  # DingTalk robot threads stay P2
            text=text,
            attachments=self._collect_attachments(media, message_ref, chat_id),
            message_ref=message_ref,
        )

    def _collect_attachments(self, media: dict[str, Any], message_ref: str, chat_id: str) -> tuple[Attachment, ...]:
        url = str(media.get("downloadUrl") or "").strip()
        if not url:
            return ()
        kind = _KIND_BY_MEDIA_TYPE.get(str(media.get("mediaType") or ""), "document")
        suffix = Path(urlsplit(url).path).suffix or _KIND_EXT[kind]
        path = self._attachment_dir() / _safe_filename(f"{message_ref}{suffix}", f"{message_ref}{_KIND_EXT[kind]}")
        try:
            data = self._fetch_bytes(url)
        except Exception as exc:
            logger.warning("gateway dingtalk: attachment %s download failed: %s", path.name, exc)
            return ()
        if len(data) > MAX_ATTACHMENT_BYTES:
            logger.info("gateway dingtalk: ignored attachment over 20MB from chat %s", chat_id)
            if self._loop is not None:  # §8: one-line notice instead of the attachment
                asyncio.run_coroutine_threadsafe(self._send_notice(chat_id, OVERSIZE_NOTICE), self._loop)
            return ()
        path.write_bytes(data)
        return (Attachment(path=path, content_type=_KIND_CONTENT_TYPE.get(kind, "application/octet-stream"),
                           kind=kind),)

    def _fetch_bytes(self, url: str) -> bytes:
        request = urllib.request.Request(url)
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    # --- outbound: robot oapi send ------------------------------------------------

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        chatbot = self._chatbot
        if chatbot is None:
            logger.warning("gateway dingtalk: send before start; dropping payload")
            return
        try:
            if payload.text:
                msg_param = json.dumps({"content": payload.text, "title": _title_of(payload.text)},
                                       ensure_ascii=False)
                staff_id = self._dm_senders.get(target.chat_id)
                if staff_id:
                    await chatbot.post_json(DIRECT_SEND_API, {"robotCode": self._client_id,
                                                              "userIds": [staff_id],
                                                              "msgKey": MSG_KEY, "msgParam": msg_param})
                else:
                    await chatbot.post_json(GROUP_SEND_API, {"robotCode": self._client_id,
                                                             "openConversationId": target.chat_id,
                                                             "msgKey": MSG_KEY, "msgParam": msg_param})
            for _attachment in payload.attachments:  # robot file sends need the media-upload API (P2)
                logger.warning("gateway dingtalk: outbound attachments are not supported yet; dropped")
        except Exception as exc:
            logger.warning("gateway dingtalk: send to conversation %s failed: %s", target.chat_id, exc)

    async def typing(self, target: SendTarget) -> None:
        return None  # capability flag says no; Outbound never schedules us

    async def _send_notice(self, chat_id: str, text: str) -> None:
        with contextlib.suppress(Exception):
            await self.send(SendTarget(chat_id=chat_id), OutboundPayload(text=text))


def build_channel(config: ChannelConfig, uploads_root: Path) -> DingTalkChannel:
    """Registry entry point: validates config, fails fast when SDK missing."""
    extra = config.extra
    values = {key: str(extra.get(key, "") or "").strip() for key in ("client_id", "client_secret")}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ValueError(f"channel 'dingtalk' requires non-empty {', '.join(missing)} (channels.dingtalk.<key>)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return DingTalkChannel(client_id=values["client_id"], client_secret=values["client_secret"],
                           uploads_root=Path(uploads_root))


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "DingTalkChannel", "build_channel"]
