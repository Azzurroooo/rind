"""Feishu (Lark) channel adapter (gateway.md §8, plan §5.6 P1).

Transport: ``lark-oapi`` WebSocket long connection (事件订阅) — Feishu dials
out, zero inbound ports.  The SDK is synchronous on its own thread: events
hand off to the gateway loop via ``run_coroutine_threadsafe`` and API calls
run in worker threads (the imapclient precedent).  Lazy-imported in
:func:`build_channel`/:meth:`FeishuChannel.start`, so a missing SDK disables
only this channel with a one-line log (§1).  §8 scope only:
``im.message.receive_v1`` → ``InboundMessage`` (media under
``<uploads>/feishu/<date>/``), ``send``/``typing``/``react``, capabilities,
config, start/stop.  The last-message-id map is transport state anchoring the
✅ reaction; markdown cards are P2 — plain text now.
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
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "feishu"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow", "app_id", "app_secret"})

CAPABILITIES = ChannelCapabilities(max_text_length=15000, len_unit="chars", supports_typing=False,
                                  supports_buttons=False, supports_reaction=True, markdown="none")

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"
_MEDIA_TYPES = {"image": "image", "audio": "audio", "video": "video", "media": "video", "file": "document"}
_KIND_META = {"image": ("image/jpeg", ".jpg"), "audio": ("audio/opus", ".opus"), "video": ("video/mp4", ".mp4")}
_FILE_TYPE_BY_KIND = {"audio": "opus", "video": "mp4", "document": "stream"}
_EMOJI_TYPES = {"✅": "DONE"}  # Feishu reaction keys are words, not glyphs


def _load_sdk() -> Any:
    """Import lark-oapi on first use; ImportError text names the fix (§1 log)."""
    try:
        lark = importlib.import_module("lark_oapi")
        importlib.import_module("lark_oapi.ws")
        importlib.import_module("lark_oapi.api.im.v1")  # request builder classes
    except ImportError as exc:
        raise ImportError(f"channel 'feishu' requires lark-oapi>=1.4 ({exc}); install it to enable the channel") from exc
    return lark


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "")).strip()).strip("._")
    return name or fallback


def _parse_content(raw: Any) -> dict[str, Any]:
    try:
        content = json.loads(str(raw or ""))
        return content if isinstance(content, dict) else {}
    except ValueError:
        return {}


def _post_text(content: dict[str, Any]) -> str:
    """Rich-text (post) content → plain text: text + link labels, line breaks kept."""
    lines: list[str] = []
    for row in content.get("content") or []:
        if not isinstance(row, list):
            continue
        parts = [str(node.get("text") or "") for node in row
                 if isinstance(node, dict) and str(node.get("tag") or "") in ("text", "a")]
        lines.append("".join(parts).strip())
    return "\n".join(line for line in lines if line)


def _message_id_of(response: Any) -> str:
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return str(data.get("message_id") or "")
    return str(getattr(getattr(response, "message", None), "message_id", "") or "")


def _data_value(response: Any, key: str) -> str:
    data = getattr(response, "data", None)
    return str(data.get(key) or "") if isinstance(data, dict) else ""


class FeishuChannel:
    """WS long-connection adapter; ``start(sink)`` opens the SDK client.  The
    adapter's only outbound-to-core call is ``await sink.inbound(...)``."""

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, app_id: str, app_secret: str, uploads_root: Path) -> None:
        self._app_id, self._app_secret = app_id, app_secret
        self._uploads_root = Path(uploads_root)
        self._sink: Any = None
        self._lark: Any = None
        self._im_v1: Any = None
        self._client: Any = None  # lark API client (send / media)
        self._ws_client: Any = None
        self._ws_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_message_ids: dict[str, str] = {}  # chat_id → last sent message_id (reaction anchor)

    # --- lifecycle -----------------------------------------------------------

    async def start(self, sink: Any) -> None:
        self._sink = sink
        lark = self._lark or _load_sdk()
        self._lark = lark
        self._loop = asyncio.get_running_loop()
        self._client = lark.Client.builder().app_id(self._app_id).app_secret(self._app_secret).build()
        dispatcher = (lark.EventDispatcherHandler.builder("", "")
                      .register_p2_im_message_receive_v1(self._on_event)
                      .build())
        self._ws_client = lark.ws.Client(self._app_id, self._app_secret, event_handler=dispatcher)
        self._ws_task = self._loop.create_task(asyncio.to_thread(self._ws_client.start), name="feishu-ws")
        logger.info("gateway feishu: ws long connection starting")

    async def stop(self) -> None:
        task, self._ws_task = self._ws_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        ws_client, self._ws_client = self._ws_client, None
        for name in ("stop", "close"):  # the SDK exposes neither consistently; best effort
            method = getattr(ws_client, name, None) if ws_client is not None else None
            if callable(method):
                with contextlib.suppress(Exception):
                    result = method()
                    if inspect.isawaitable(result):
                        await result
                break
        self._client = None

    def _im_v1_module(self) -> Any:
        if self._im_v1 is None:
            self._im_v1 = importlib.import_module("lark_oapi.api.im.v1")
        return self._im_v1

    # --- inbound: receive_v1 event → InboundMessage (SDK thread) -----------------

    def _on_event(self, data: Any) -> None:
        try:
            message = self._normalize_event(data)
        except Exception as exc:
            logger.warning("gateway feishu: event normalize failed: %s", exc)
            return
        if message is not None and self._loop is not None:
            asyncio.run_coroutine_threadsafe(self._deliver(message), self._loop)

    async def _deliver(self, message: InboundMessage) -> None:
        if self._sink is not None:
            await self._sink.inbound(message)

    def _normalize_event(self, data: Any) -> InboundMessage | None:
        event = getattr(data, "event", None)
        message = getattr(event, "message", None)
        sender = getattr(event, "sender", None)
        chat_id = str(getattr(message, "chat_id", "") or "")
        open_id = str(getattr(getattr(sender, "sender_id", None), "open_id", "") or "")
        message_id = str(getattr(message, "message_id", "") or "")
        if not chat_id or not open_id or not message_id:
            return None
        message_type = str(getattr(message, "message_type", "") or "")
        content = _parse_content(getattr(message, "content", None))
        text = str(content.get("text") or "") if message_type == "text" else _post_text(content)
        attachments = self._collect_attachments(message_id, message_type, chat_id)
        return InboundMessage(
            channel=CHANNEL_ID,
            chat_id=chat_id,
            chat_type="dm" if str(getattr(message, "chat_type", "")) == "p2p" else "group",
            sender_id=open_id,
            sender_name=open_id,
            thread_id=None,  # Feishu threading (root_id) stays P2
            text=text,
            attachments=attachments,
            message_ref=message_id,
        )

    def _collect_attachments(self, message_id: str, message_type: str, chat_id: str) -> tuple[Attachment, ...]:
        kind = _MEDIA_TYPES.get(message_type)
        if kind is None:
            return ()
        path = self._attachment_dir() / f"{message_id}{_KIND_META.get(kind, ('', '.bin'))[1]}"
        file_type = "image" if kind == "image" else _FILE_TYPE_BY_KIND.get(kind, "file")
        im_v1 = self._im_v1_module()
        request = (im_v1.MessageResourcesGetRequest.builder()
                   .message_id(message_id).file_type(file_type).build())
        try:
            response = self._client.im.v1.message_resources_get(request)
        except Exception as exc:
            logger.warning("gateway feishu: attachment %s download failed: %s", path.name, exc)
            return ()
        data = getattr(response, "file", None)
        if not isinstance(data, (bytes, bytearray)):
            logger.warning("gateway feishu: attachment %s download empty: %s", path.name,
                           getattr(response, "msg", ""))
            return ()
        if len(data) > MAX_ATTACHMENT_BYTES:
            logger.info("gateway feishu: ignored attachment over 20MB from chat %s", chat_id)
            with contextlib.suppress(Exception):
                self._send_message(chat_id, "text", {"text": OVERSIZE_NOTICE})
            return ()
        path.write_bytes(data)
        return (Attachment(path=path, content_type=_KIND_META.get(kind, ("application/octet-stream", ""))[0],
                           kind=kind),)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    # --- outbound (sync SDK → worker threads) -----------------------------------

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        if self._client is None:
            logger.warning("gateway feishu: send before start; dropping payload")
            return
        try:
            if payload.text:
                message_id = await asyncio.to_thread(self._send_message, target.chat_id, "text",
                                                     {"text": payload.text})
                if message_id:  # transport state: anchor for the ✅ completion reaction
                    self._last_message_ids[target.chat_id] = message_id
            for attachment in payload.attachments:  # choices: no buttons — pump rendered the numbered list
                await asyncio.to_thread(self._post_attachment, target.chat_id, attachment)
        except Exception as exc:
            logger.warning("gateway feishu: send to chat %s failed: %s", target.chat_id, exc)

    def _send_message(self, chat_id: str, msg_type: str, content: dict[str, Any]) -> str:
        im_v1 = self._im_v1_module()
        body = (im_v1.CreateMessageRequestBody.builder().receive_id(chat_id).msg_type(msg_type)
                .content(json.dumps(content, ensure_ascii=False)).build())
        request = im_v1.CreateMessageRequest.builder().receive_id_type("chat_id").request_body(body).build()
        return _message_id_of(self._client.im.v1.message.create(request))

    def _post_attachment(self, chat_id: str, attachment: Attachment) -> None:
        data = attachment.path.read_bytes()
        im_v1 = self._im_v1_module()
        if attachment.kind == "image":
            body = im_v1.CreateImageRequestBody.builder().image_type("message").image(data).build()
            request = im_v1.CreateImageRequest.builder().request_body(body).build()
            key = _data_value(self._client.im.v1.image.create(request), "image_key")
            content = {"image_key": key}
        else:
            body = (im_v1.CreateFileRequestBody.builder().file_type(_FILE_TYPE_BY_KIND.get(attachment.kind, "stream"))
                    .file_name(attachment.path.name).file(data).build())
            request = im_v1.CreateFileRequest.builder().request_body(body).build()
            key = _data_value(self._client.im.v1.file.create(request), "file_key")
            content = {"file_key": key}
        self._send_message(chat_id, "image" if attachment.kind == "image" else "file", content)

    async def react(self, target: SendTarget, emoji: str) -> None:
        """✅ completion receipt on the last message we posted in that chat."""
        if self._client is None:
            return
        message_id = self._last_message_ids.get(target.chat_id)
        if not message_id:
            logger.debug("gateway feishu: no message to react on in chat %s", target.chat_id)
            return
        try:
            await asyncio.to_thread(self._create_reaction, message_id, _EMOJI_TYPES.get(emoji, emoji.strip(":")))
        except Exception as exc:
            logger.debug("gateway feishu: reaction failed: %s", exc)

    def _create_reaction(self, message_id: str, emoji_type: str) -> None:
        im_v1 = self._im_v1_module()
        body = (im_v1.CreateMessageReactionRequestBody.builder()
                .reaction_type(im_v1.Emoji.builder().emoji_type(emoji_type).build()).build())
        request = im_v1.CreateMessageReactionRequest.builder().message_id(message_id).request_body(body).build()
        self._client.im.v1.message_reaction.create(request)

    async def typing(self, target: SendTarget) -> None:
        return None  # capability flag says no; Outbound never schedules us


def build_channel(config: ChannelConfig, uploads_root: Path) -> FeishuChannel:
    """Registry entry point: validates config, fails fast when SDK missing."""
    extra = config.extra
    values = {key: str(extra.get(key, "") or "").strip() for key in ("app_id", "app_secret")}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ValueError(f"channel 'feishu' requires non-empty {', '.join(missing)} (channels.feishu.<key>)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return FeishuChannel(app_id=values["app_id"], app_secret=values["app_secret"], uploads_root=Path(uploads_root))


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "FeishuChannel", "build_channel"]
