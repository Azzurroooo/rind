"""Slack channel adapter (gateway.md §8, plan §5.6 P1).

Transport: slack_bolt Socket Mode WS — Slack dials out to us, so the gateway
needs zero inbound ports (enterprise-friendly).  Optional dep ``slack_bolt``
lazy-imported in :func:`build_channel`/:meth:`SlackChannel.start`; a missing
SDK disables only this channel with a one-line log (§1).

§8 scope and nothing else: ``message`` events → ``InboundMessage`` (file
attachments persisted under ``<uploads>/slack/<date>/``), ``send`` /
``typing`` / ``react``, capability/config constants, start/stop.  Session
logic, retries, chunking, auth and persistence live in the pump/core.  The
in-memory last-message-ts map is transport state for the ✅ receipt reaction,
not session state.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import os
import re
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "slack"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow", "app_token", "bot_token"})

CAPABILITIES = ChannelCapabilities(
    max_text_length=40000,
    len_unit="chars",
    supports_typing=False,  # bots have no typing indicator API on Slack
    supports_buttons=False,
    supports_reaction=True,  # reactions.add ✅ on turn completion via the react hook
    markdown="subset",  # Slack markdown is a subset: send chunker output as-is
)

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"
# message subtypes that carry no user turn: edits, deletes, bot echoes
_SKIPPED_SUBTYPES = frozenset({"message_changed", "message_deleted", "message_replied", "bot_message"})
# Outbound.react passes the raw ✅ glyph; Slack's API wants the emoji name.
_EMOJI_NAMES = {"✅": "white_check_mark"}

_EXTENSION_FOR_KIND = {"image": ".jpg", "audio": ".ogg", "video": ".mp4", "document": ".bin"}

_KIND_BY_PREFIX = (("image/", "image"), ("audio/", "audio"), ("video/", "video"))


def _load_sdk() -> Any:
    """Import slack_bolt (app + socket-mode adapter) on first use; ImportError
    text names the fix (§1 log)."""
    try:
        importlib.import_module("slack_bolt")  # SDK core: presence check first
        async_app = importlib.import_module("slack_bolt.async_app")
        adapter = importlib.import_module("slack_bolt.adapter.socket_mode.aiohttp")
    except ImportError as exc:
        raise ImportError(
            f"channel 'slack' requires slack_bolt>=1.18 ({exc}); install it to enable the channel"
        ) from exc
    return async_app, adapter


def _kind_of_content_type(content_type: str) -> str:
    for prefix, kind in _KIND_BY_PREFIX:
        if content_type.startswith(prefix):
            return kind
    return "document"


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "")).strip()).strip("._")
    return name or fallback


def _sender_name(event: dict[str, Any]) -> str:
    profile = event.get("user_profile")
    name = str(profile.get("display_name") or profile.get("real_name") or "") if isinstance(profile, dict) else ""
    return name or str(event.get("user") or "")


def _response_ts(response: Any) -> str:
    """Slack AsyncSlackResponse exposes .data / __getitem__; tolerate both."""
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return str(data.get("ts", "") or "")
    try:
        return str(response["ts"] or "")
    except Exception:
        return ""


class SlackChannel:
    """Socket Mode adapter; ``start(sink)`` connects the WS and registers the
    message handler.  ``sink`` is the pump — the adapter's only outbound-to-core
    call is ``await sink.inbound(InboundMessage)``."""

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, app_token: str, bot_token: str, uploads_root: Path) -> None:
        self._app_token, self._bot_token = app_token, bot_token
        self._uploads_root = Path(uploads_root)
        self._sink: Any = None
        self._client: Any = None
        self._socket_handler: Any = None
        self._last_ts: dict[str, str] = {}  # chat_id → ts of the last message we posted

    # --- lifecycle -----------------------------------------------------------

    async def start(self, sink: Any) -> None:
        self._sink = sink
        async_app, adapter = _load_sdk()
        app = async_app.AsyncApp(token=self._bot_token)
        self._client = app.client
        app.event("message")(self._on_message)
        self._socket_handler = adapter.AsyncSocketModeHandler(app, self._app_token)
        await self._socket_handler.connect_async()
        logger.info("gateway slack: socket mode connected")

    async def stop(self) -> None:
        handler, self._socket_handler = self._socket_handler, None
        if handler is not None:
            try:
                await handler.close_async()
            except Exception as exc:  # best effort; the process is shutting the channel down
                logger.debug("gateway slack: socket close failed: %s", exc)
        self._client = None

    # --- inbound: SDK event → InboundMessage -----------------------------------

    async def _on_message(self, event: dict[str, Any]) -> None:
        inbound = await self._normalize_event(event)
        if inbound is not None and self._sink is not None:
            await self._sink.inbound(inbound)

    async def _normalize_event(self, event: dict[str, Any]) -> InboundMessage | None:
        if event.get("bot_id") or event.get("subtype") in _SKIPPED_SUBTYPES:
            return None  # self + other bots (loop prevention), edits/deletes
        chat_id = str(event.get("channel") or "")
        sender_id = str(event.get("user") or "")
        if not chat_id or not sender_id:
            return None
        thread_ts = event.get("thread_ts")
        return InboundMessage(
            channel=CHANNEL_ID,
            chat_id=chat_id,
            chat_type="dm" if event.get("channel_type") == "im" else "group",
            sender_id=sender_id,
            sender_name=_sender_name(event),
            thread_id=str(thread_ts) if thread_ts else None,
            text=str(event.get("text") or ""),
            attachments=await self._collect_attachments(event, chat_id),
            message_ref=str(event.get("ts") or ""),
        )

    async def _collect_attachments(self, event: dict[str, Any], chat_id: str) -> tuple[Attachment, ...]:
        files = [f for f in event.get("files") or [] if isinstance(f, dict)]
        if not files:
            return ()
        directory = self._attachment_dir()
        saved: list[Attachment] = []
        for position, file in enumerate(files, start=1):
            size = int(file.get("size") or 0)
            if size > MAX_ATTACHMENT_BYTES:
                logger.info("gateway slack: ignored attachment over 20MB in channel %s", chat_id)
                await self._send_notice(chat_id, OVERSIZE_NOTICE)
                continue
            content_type = str(file.get("mimetype") or "") or "application/octet-stream"
            url = str(file.get("url_private_download") or file.get("url_private") or "")
            fallback = f"{event.get('ts', 'file')}-{position}{_EXTENSION_FOR_KIND[_kind_of_content_type(content_type)]}"
            path = directory / _safe_filename(file.get("name"), fallback)
            if not url:
                continue
            try:
                data = await self._fetch_bytes(url)
            except Exception as exc:
                logger.warning("gateway slack: attachment %s download failed: %s", path.name, exc)
                continue
            path.write_bytes(data)
            saved.append(Attachment(path=path, content_type=content_type, kind=_kind_of_content_type(content_type)))
        return tuple(saved)

    async def _fetch_bytes(self, url: str) -> bytes:
        """Authenticated file download (url_private needs the bot token)."""
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._bot_token}"})

        def fetch() -> bytes:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()

        return await asyncio.to_thread(fetch)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    async def _send_notice(self, chat_id: str, text: str) -> None:
        if self._client is None:
            return
        try:
            await self._client.chat_postMessage(channel=chat_id, text=text)
        except Exception as exc:
            logger.warning("gateway slack: notice send failed: %s", exc)

    # --- outbound ---------------------------------------------------------------

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        client = self._client
        if client is None:
            logger.warning("gateway slack: send before start; dropping payload")
            return
        try:
            if payload.text:
                response = await client.chat_postMessage(channel=target.chat_id, text=payload.text,
                                                         thread_ts=target.thread_id)
                ts = _response_ts(response)
                if ts:  # transport state for the ✅ completion reaction
                    self._last_ts[target.chat_id] = ts
            for attachment in payload.attachments:  # choices: no buttons — pump rendered the numbered list
                await client.files_upload_v2(channel=target.chat_id, file=str(attachment.path),
                                             filename=attachment.path.name, thread_ts=target.thread_id)
        except Exception as exc:
            logger.warning("gateway slack: send to channel %s failed: %s", target.chat_id, exc)

    async def react(self, target: SendTarget, emoji: str) -> None:
        """✅ completion receipt: reaction on our last posted message (thread
        root as fallback when nothing was posted yet)."""
        client = self._client
        if client is None:
            return
        ts = self._last_ts.get(target.chat_id) or target.thread_id
        if not ts:
            logger.debug("gateway slack: no message ts to react on in channel %s", target.chat_id)
            return
        try:
            await client.reactions_add(channel=target.chat_id, timestamp=ts,
                                       name=_EMOJI_NAMES.get(emoji, emoji.strip(":")))
        except Exception as exc:
            logger.debug("gateway slack: reaction failed: %s", exc)

    async def typing(self, target: SendTarget) -> None:
        return None  # capability flag says no; Outbound never schedules us


def build_channel(config: ChannelConfig, uploads_root: Path) -> SlackChannel:
    """Registry entry point: validates config, fails fast when SDK missing."""
    extra = config.extra
    app_token = str(extra.get("app_token", "") or "").strip()
    bot_token = str(extra.get("bot_token", "") or "").strip() or str(config.token or "").strip()
    if not app_token.startswith("xapp-"):
        raise ValueError("channel 'slack' requires a Slack app token starting with xapp- (channels.slack.app_token)")
    if not bot_token.startswith("xoxb-"):
        raise ValueError("channel 'slack' requires a Slack bot token starting with xoxb- (channels.slack.bot_token)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return SlackChannel(app_token=app_token, bot_token=bot_token, uploads_root=Path(uploads_root))


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "SlackChannel", "build_channel"]
