"""Discord channel adapter (gateway.md §8, P0).

discord.py gateway client with ``intents.message_content`` set explicitly; the
client runs as one asyncio task next to the pump loop.  Every bot-authored
message (self included) is dropped before normalization — loop prevention.
The SDK is loaded lazily in :func:`build_channel`/:meth:`DiscordChannel.start`
so this module imports without discord.py installed; a missing SDK disables
only this channel with a one-line log (gateway.md §1).

Allowed content per §8, and nothing else: SDK event → ``InboundMessage``
(attachments persisted under ``<uploads>/discord/<date>/``), ``send``,
capability/config constants, start/stop.  Session logic, retries, chunking,
auth and persistence live in the pump/core, never here.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import inspect
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "discord"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow"})

CAPABILITIES = ChannelCapabilities(
    max_text_length=2000,
    len_unit="chars",
    supports_typing=False,  # no typing indicator API; pump stays quiet instead
    supports_buttons=False,  # P0 numbered list; discord.ui.View is a P1 upgrade
    supports_reaction=False,
    markdown="subset",  # Discord markdown ≈ subset: send chunker output as-is
)

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"


def _load_sdk() -> Any:
    """Import discord.py on first use; ImportError text names the fix (§1 log)."""
    try:
        return importlib.import_module("discord")
    except ImportError as exc:
        raise ImportError(f"channel 'discord' requires discord.py>=2.3 ({exc}); install it to enable the channel") from exc


@dataclass(frozen=True, slots=True)
class _MediaSource:
    """One downloadable Discord attachment with its normalized metadata."""

    source: Any
    kind: str  # Attachment.kind vocabulary
    content_type: str


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


class DiscordChannel:
    """discord.py-backed adapter; ``start(sink)`` opens the gateway socket.

    ``sink`` is the pump — the adapter's only outbound-to-core call is
    ``await sink.inbound(InboundMessage)``; everything else (sessions,
    security, chunking) happens above this file.
    """

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, token: str, uploads_root: Path) -> None:
        self._token = token
        self._uploads_root = Path(uploads_root)
        self._sink: Any = None
        self._client: Any = None
        self._discord: Any = None
        self._task: asyncio.Task[None] | None = None

    # --- lifecycle -----------------------------------------------------------

    async def start(self, sink: Any) -> None:
        self._sink = sink
        discord = self._discord or _load_sdk()
        self._discord = discord
        intents = discord.Intents.default()
        intents.message_content = True  # required to see non-mention content
        client = discord.Client(intents=intents)
        self._client = client
        client.event(self.on_message)
        self._task = asyncio.get_running_loop().create_task(
            client.start(self._token), name="discord-client"
        )
        self._task.add_done_callback(self._on_client_done)

    async def stop(self) -> None:
        client, self._client = self._client, None
        close = getattr(client, "close", None)
        if callable(close):
            with contextlib.suppress(Exception):
                result = close()
                if inspect.isawaitable(result):
                    await result
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _on_client_done(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.warning("gateway discord: client stopped: %s", exc)

    # --- inbound: SDK event → InboundMessage -----------------------------------

    async def on_message(self, message: Any) -> None:
        inbound = await self._normalize_message(message)
        if inbound is None or self._sink is None:
            return
        await self._sink.inbound(inbound)

    async def _normalize_message(self, message: Any) -> InboundMessage | None:
        author = getattr(message, "author", None)
        if author is None or bool(getattr(author, "bot", False)):  # all bots, self included
            return None
        channel = getattr(message, "channel", None)
        chat_id = str(getattr(channel, "id", "") or "")
        if not chat_id:
            return None
        chat_type = "dm" if getattr(channel, "guild", None) is None else "group"
        thread = getattr(message, "thread", None)
        sender_id = str(getattr(author, "id", "") or "")
        if not sender_id:
            return None
        return InboundMessage(
            channel=CHANNEL_ID,
            chat_id=chat_id,
            chat_type=chat_type,
            sender_id=sender_id,
            sender_name=_sender_name(author),
            thread_id=str(getattr(thread, "id", "") or "") or None,
            text=str(getattr(message, "content", "") or ""),
            attachments=await self._collect_attachments(message, channel),
            message_ref=str(getattr(message, "id", "") or ""),
        )

    async def _collect_attachments(self, message: Any, channel: Any) -> tuple[Attachment, ...]:
        sources = getattr(message, "attachments", None) or ()
        if not sources:
            return ()
        directory = self._attachment_dir()
        saved: list[Attachment] = []
        for position, source in enumerate(sources, start=1):
            content_type = str(getattr(source, "content_type", "") or "application/octet-stream")
            size = int(getattr(source, "size", 0) or 0)
            if size > MAX_ATTACHMENT_BYTES:
                logger.info("gateway discord: ignored attachment over 20MB in channel %s", getattr(channel, "id", "?"))
                await self._send_notice(channel, OVERSIZE_NOTICE)
                continue
            fallback = f"{getattr(message, 'id', 'file')}-{position}"
            path = directory / _safe_filename(getattr(source, "filename", None), fallback)
            save = getattr(source, "save", None)
            if not callable(save):
                continue
            try:
                result = save(path)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                logger.warning("gateway discord: attachment %s download failed: %s", path.name, exc)
                continue
            saved.append(Attachment(path=path, content_type=content_type, kind=_kind_of_content_type(content_type)))
        return tuple(saved)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    async def _send_notice(self, channel: Any, text: str) -> None:
        send = getattr(channel, "send", None)
        if not callable(send):
            return
        try:
            result = send(text)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            logger.warning("gateway discord: notice send failed: %s", exc)

    # --- outbound ---------------------------------------------------------------

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        channel = self._resolve_channel(target)
        if channel is None:
            logger.warning("gateway discord: channel %s not resolvable; dropping payload", target.chat_id)
            return
        try:
            if payload.text:
                await channel.send(payload.text)
            for attachment in payload.attachments:
                await self._send_attachment(channel, attachment)
            # choices: capabilities.supports_buttons is False → the pump already
            # rendered the numbered list into text; nothing native to attach.
        except Exception as exc:
            logger.warning("gateway discord: send to channel %s failed: %s", target.chat_id, exc)

    def _resolve_channel(self, target: SendTarget) -> Any:
        client = self._client
        getter = getattr(client, "get_channel", None)
        if client is None or not callable(getter):
            return None
        key = target.thread_id or target.chat_id  # threads resolve like channels
        try:
            key = int(key)
        except (TypeError, ValueError):
            pass
        return getter(key)

    async def _send_attachment(self, channel: Any, attachment: Attachment) -> None:
        file_factory = getattr(self._discord, "File", None)
        if file_factory is None:
            logger.warning("gateway discord: SDK file factory unavailable; dropping attachment %s", attachment.path.name)
            return
        await channel.send(file=file_factory(str(attachment.path)))

    async def typing(self, target: SendTarget) -> None:
        return None  # capability flag says no; Outbound never schedules us


def _sender_name(author: Any) -> str:
    return str(getattr(author, "display_name", None) or getattr(author, "name", "") or "")


def build_channel(config: ChannelConfig, uploads_root: Path) -> DiscordChannel:
    """Registry entry point: validates config, fails fast when SDK missing."""
    if not str(config.token or "").strip():
        raise ValueError("channel 'discord' requires a non-empty token (channels.discord.token)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return DiscordChannel(token=config.token.strip(), uploads_root=Path(uploads_root))


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "DiscordChannel", "build_channel"]
