"""WhatsApp Cloud API channel (gateway.md §8, plan §5.6 P2).

Transport: webhook + REST (§5.6).  Meta pushes user messages to a public
webhook URL, so deployment needs a public address or a tunnel pointing at
``webhook_host:webhook_port``; sends go through the Graph REST API.  One
optional dependency, ``aiohttp`` (webhook server + API client), lazy-imported
in :func:`build_channel`/:meth:`WhatsAppChannel.start` — a missing SDK
disables only this channel with a one-line log (§1).

§8 scope and nothing else: webhook payload → ``InboundMessage`` (media
persisted under ``<uploads>/whatsapp/<date>/``), ``send`` text/attachments,
capability/config constants, start/stop.  Session logic, retries, chunking,
auth and persistence live in the pump/core; the bearer token comes from
config on every call.
"""

from __future__ import annotations

import contextlib
import importlib
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "whatsapp"
CONFIG_KEYS = frozenset(
    {"allow_from", "phone_number_id", "access_token", "verify_token", "webhook_host", "webhook_port"}
)

CAPABILITIES = ChannelCapabilities(
    max_text_length=4096,
    len_unit="utf16",
    supports_typing=False,  # no typing indicator API on Cloud API
    supports_buttons=False,
    supports_reaction=False,
    markdown="none",  # pump/chunker degrade to plain text
)

GRAPH_BASE = "https://graph.facebook.com/v20.0"
WEBHOOK_PATH = "/webhook"
DEFAULT_WEBHOOK_HOST = "0.0.0.0"
DEFAULT_WEBHOOK_PORT = 8080
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"

_KIND_EXT = {"image": ".jpg", "audio": ".ogg", "video": ".mp4", "document": ".bin"}
_INBOUND_MEDIA_KINDS = ("image", "document", "audio", "video")  # msg["type"] values carrying media ids


def _load_sdk() -> Any:
    """Import aiohttp (top package + web submodule); ImportError names the fix (§1)."""
    try:
        module = importlib.import_module("aiohttp")
        importlib.import_module("aiohttp.web")  # binds aiohttp.web for attribute access
    except ImportError as exc:
        raise ImportError(f"channel 'whatsapp' requires aiohttp>=3.9 ({exc}); install it to enable the channel") from exc
    return module


def _kind_of_content_type(content_type: str) -> str:
    if content_type.startswith("image/"):
        return "image"
    if content_type.startswith("audio/"):
        return "audio"
    if content_type.startswith("video/"):
        return "video"
    return "document"


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "")).strip()).strip("._")
    return name or fallback


class WhatsAppChannel:
    """Webhook + Graph REST adapter; ``start(sink)`` serves the webhook and
    opens the API client.  ``sink`` is the pump — the adapter's only
    outbound-to-core call is ``await sink.inbound(InboundMessage)``."""

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, phone_number_id: str, access_token: str, verify_token: str, uploads_root: Path,
                 host: str = DEFAULT_WEBHOOK_HOST, port: int = DEFAULT_WEBHOOK_PORT) -> None:
        self._phone_number_id = phone_number_id
        self._access_token = access_token
        self._verify_token = verify_token
        self._uploads_root = Path(uploads_root)
        self._host, self._port = host, port
        self._sink: Any = None
        self._aiohttp: Any = None
        self._session: Any = None
        self._runner: Any = None

    # --- lifecycle -----------------------------------------------------------

    async def start(self, sink: Any) -> None:
        self._sink = sink
        aiohttp = self._aiohttp or _load_sdk()
        self._aiohttp = aiohttp
        self._session = aiohttp.ClientSession()
        app = aiohttp.web.Application()
        app.router.add_get(WEBHOOK_PATH, self._handle_verify)
        app.router.add_post(WEBHOOK_PATH, self._handle_payload)
        runner = aiohttp.web.AppRunner(app)
        await runner.setup()
        await aiohttp.web.TCPSite(runner, self._host, self._port).start()
        self._runner = runner
        logger.info("gateway whatsapp: webhook listening on %s:%s%s (needs a public/tunnel URL)",
                    self._host, self._port, WEBHOOK_PATH)

    async def stop(self) -> None:
        runner, self._runner = self._runner, None
        if runner is not None:
            with contextlib.suppress(Exception):
                await runner.cleanup()
        session, self._session = self._session, None
        if session is not None:
            with contextlib.suppress(Exception):
                await session.close()

    # --- inbound: webhook payload → InboundMessage ------------------------------

    async def _handle_verify(self, request: Any) -> Any:
        """Meta subscription handshake: echo hub.challenge iff mode/token match."""
        query = request.query
        response = self._aiohttp.web.Response
        if query.get("hub.mode") != "subscribe" or not query.get("hub.challenge"):
            return response(status=403)
        if query.get("hub.verify_token") != self._verify_token:
            return response(status=403)
        return response(text=str(query.get("hub.challenge")))

    async def _handle_payload(self, request: Any) -> Any:
        response = self._aiohttp.web.Response
        try:
            body = await request.json()
        except Exception as exc:
            logger.warning("gateway whatsapp: webhook body is not JSON: %s", exc)
            return response(status=400)
        for entry in body.get("entry") or ():
            for change in entry.get("changes") or ():
                value = change.get("value") or {}
                metadata = value.get("metadata") or {}
                if str(metadata.get("phone_number_id", "") or "") != self._phone_number_id:
                    return response(status=403)  # another number sharing this webhook URL
                for message in value.get("messages") or ():
                    inbound = await self._normalize_message(message)
                    if inbound is not None and self._sink is not None:
                        await self._sink.inbound(inbound)
        return response(text="EVENT_RECEIVED")  # Meta docs acknowledge with this literal

    async def _normalize_message(self, message: dict[str, Any]) -> InboundMessage | None:
        sender = str(message.get("from", "") or "").strip()
        kind = str(message.get("type", "") or "")
        if not sender:
            return None
        text = ""
        if kind == "text":
            text = str((message.get("text") or {}).get("body", "") or "")
        elif kind in _INBOUND_MEDIA_KINDS:
            text = str((message.get(kind) or {}).get("caption", "") or "")
        elif kind == "button":  # template quick reply: the label is the user's answer
            text = str((message.get("button") or {}).get("text", "") or "")
        else:
            return None  # interactive/system/reaction: no plain user turn for P2
        return InboundMessage(
            channel=CHANNEL_ID, chat_id=sender, chat_type="dm",  # Cloud API is business ↔ one customer
            sender_id=sender, sender_name=sender, thread_id=None, text=text,
            attachments=await self._collect_attachments(message, sender),
            message_ref=str(message.get("id", "") or ""),
        )

    async def _collect_attachments(self, message: dict[str, Any], sender: str) -> tuple[Attachment, ...]:
        kind = str(message.get("type", "") or "")
        if kind not in _INBOUND_MEDIA_KINDS:
            return ()
        block = message.get(kind) or {}
        media_id = str(block.get("id", "") or "")
        if not media_id:
            return ()
        reference = str(message.get("id", "") or "media")
        try:
            meta = await self._graph_json(f"{GRAPH_BASE}/{media_id}")
        except Exception as exc:
            logger.warning("gateway whatsapp: media metadata %s fetch failed: %s", media_id, exc)
            return ()
        if int(meta.get("file_size", 0) or 0) > MAX_ATTACHMENT_BYTES:
            logger.info("gateway whatsapp: ignored attachment over 20MB from %s", sender)
            await self._send_notice(sender, OVERSIZE_NOTICE)
            return ()
        try:
            data = await self._graph_bytes(str(meta.get("url", "") or ""))
        except Exception as exc:
            logger.warning("gateway whatsapp: media %s download failed: %s", media_id, exc)
            return ()
        content_type = str(meta.get("mime_type", "") or "") or "application/octet-stream"
        fallback = f"{reference}{_KIND_EXT.get(kind, '.bin')}"
        path = self._attachment_dir() / _safe_filename(block.get("filename"), fallback)
        path.write_bytes(data)
        return (Attachment(path=path, content_type=content_type, kind=_kind_of_content_type(content_type)),)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _bearer(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}

    async def _graph_json(self, url: str) -> dict[str, Any]:
        async with self._session.get(url, headers=self._bearer()) as response:
            return await response.json()

    async def _graph_bytes(self, url: str) -> bytes:
        async with self._session.get(url, headers=self._bearer()) as response:
            return await response.read()

    async def _post_json(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        async with self._session.post(url, headers=self._bearer(), json=payload) as response:
            return await response.json()

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        if self._session is None:
            logger.warning("gateway whatsapp: send before start; dropping payload")
            return
        try:
            if payload.text:
                await self._post_json(f"{GRAPH_BASE}/{self._phone_number_id}/messages", {
                    "messaging_product": "whatsapp", "recipient_type": "individual",
                    "to": target.chat_id, "type": "text",
                    "text": {"body": payload.text, "preview_url": False}})
            for attachment in payload.attachments:
                await self._send_attachment(target.chat_id, attachment)
            # choices: no native buttons (capabilities) — pump already rendered the numbered list
        except Exception as exc:
            logger.warning("gateway whatsapp: send to %s failed: %s", target.chat_id, exc)

    async def _send_attachment(self, to: str, attachment: Attachment) -> None:
        kind = attachment.kind if attachment.kind in _INBOUND_MEDIA_KINDS else "document"
        media_id = await self._upload_media(attachment)
        await self._post_json(f"{GRAPH_BASE}/{self._phone_number_id}/messages", {
            "messaging_product": "whatsapp", "recipient_type": "individual",
            "to": to, "type": kind, kind: {"id": media_id}})

    async def _upload_media(self, attachment: Attachment) -> str:
        form = self._aiohttp.FormData()
        form.add_field("file", attachment.path.read_bytes(),
                       filename=attachment.path.name, content_type=attachment.content_type)
        form.add_field("type", attachment.content_type)
        form.add_field("messaging_product", "whatsapp")
        async with self._session.post(f"{GRAPH_BASE}/{self._phone_number_id}/media",
                                      headers=self._bearer(), data=form) as response:
            data = await response.json()
        media_id = str(data.get("id", "") or "")
        if not media_id:
            raise RuntimeError(f"whatsapp media upload failed: {data}")
        return media_id

    async def _send_notice(self, to: str, text: str) -> None:
        if self._session is None:
            return
        with contextlib.suppress(Exception):
            await self._post_json(f"{GRAPH_BASE}/{self._phone_number_id}/messages", {
                "messaging_product": "whatsapp", "recipient_type": "individual",
                "to": to, "type": "text", "text": {"body": text, "preview_url": False}})

    async def typing(self, target: SendTarget) -> None:
        return None  # capability flag says no; Outbound never schedules us


def build_channel(config: ChannelConfig, uploads_root: Path) -> WhatsAppChannel:
    """Registry entry point: validates config, fails fast when the SDK is missing."""
    extra = config.extra
    values = {key: str(extra.get(key, "") or "").strip()
              for key in ("phone_number_id", "access_token", "verify_token")}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ValueError(f"channel 'whatsapp' requires non-empty {', '.join(missing)} (channels.whatsapp.<key>)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return WhatsAppChannel(
        phone_number_id=values["phone_number_id"], access_token=values["access_token"],
        verify_token=values["verify_token"], uploads_root=Path(uploads_root),
        host=str(extra.get("webhook_host", "") or DEFAULT_WEBHOOK_HOST),
        port=int(extra.get("webhook_port") or DEFAULT_WEBHOOK_PORT),
    )


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "WhatsAppChannel", "build_channel"]
