"""Telegram channel adapter (gateway.md §8, P0 reference).

aiogram 3 long polling: ``delete_webhook`` then a manual ``get_updates`` loop,
which embeds cleanly into the gateway's async startup (no Runner ownership of
the event loop).  This module imports without aiogram installed — the SDK is
loaded lazily in :func:`build_channel`/:meth:`TelegramChannel.start`, so a
missing SDK disables only this channel with a one-line log (gateway.md §1).

Allowed content per §8, and nothing else: SDK event → ``InboundMessage``
(attachments persisted under ``<uploads>/telegram/<date>/``), ``send``,
``typing``, capability/config constants, start/stop.  Session logic, retries,
chunking, auth and persistence live in the pump/core, never here.
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

CHANNEL_ID = "telegram"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow", "proxy"})

CAPABILITIES = ChannelCapabilities(
    max_text_length=4000,
    len_unit="utf16",
    supports_typing=True,
    supports_buttons=True,  # inline keyboard: callback_data "ans:<index>" loops back as digit text
    supports_reaction=True,  # setMessageReaction with the pinned 👀 emoji (see react)
    markdown="none",  # pump/chunker degrade to plain text; we send with parse_mode=None
)

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"
BUTTON_CALLBACK_PREFIX = "ans:"
LONG_POLL_SECONDS = 25
POLL_ERROR_PAUSE_SECONDS = 3.0
TYPING_ACTION = "typing"
# Telegram's default reaction catalogue is narrow — private chats allow only
# 👀/🔥/😍 unless the chat defines a custom list — so every status maps to the
# pinned 👀 ("seen/working"); setMessageReaction failures degrade to a log.
REACTION_EMOJI = "👀"

_EXTENSION_FOR_KIND = {"image": ".jpg", "audio": ".ogg", "video": ".mp4", "document": ".bin"}


def _load_sdk() -> Any:
    """Import aiogram on first use; ImportError text names the fix (§1 log)."""
    try:
        return importlib.import_module("aiogram")
    except ImportError as exc:
        raise ImportError(f"channel 'telegram' requires aiogram>=3.4 ({exc}); install it to enable the channel") from exc


@dataclass(frozen=True, slots=True)
class _MediaSource:
    """One downloadable Telegram media object with its normalized metadata."""

    media: Any
    kind: str  # Attachment.kind vocabulary
    content_type: str
    filename: str | None


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


def _sender_name(user: Any) -> str:
    parts = [str(getattr(user, "first_name", "") or ""), str(getattr(user, "last_name", "") or "")]
    name = " ".join(part for part in parts if part).strip()
    return name or str(getattr(user, "username", "") or "")


class TelegramChannel:
    """aiogram-backed adapter; ``start(sink)`` begins long polling.

    ``sink`` is the pump — the adapter's only outbound-to-core call is
    ``await sink.inbound(InboundMessage)``; everything else (sessions,
    security, chunking) happens above this file.
    """

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, token: str, uploads_root: Path, proxy: str = "") -> None:
        self._token = token
        # aiogram/aiohttp ignore system proxies by default; users behind a
        # local proxy (Clash etc.) must name it explicitly or direct connects
        # to api.telegram.org time out.
        self._proxy = proxy.strip()
        self._uploads_root = Path(uploads_root)
        self._sink: Any = None
        self._bot: Any = None
        self._aiogram: Any = None
        self._poll_task: asyncio.Task[None] | None = None
        self._last_message_id: dict[str, int] = {}  # chat_id → last posted message (reaction anchor)

    # --- lifecycle -----------------------------------------------------------

    async def start(self, sink: Any) -> None:
        self._sink = sink
        aiogram = self._aiogram or _load_sdk()
        self._aiogram = aiogram
        if self._proxy:
            session = aiogram.client.session.aiohttp.AiohttpSession(proxy=self._proxy)
            self._bot = aiogram.Bot(token=self._token, session=session)
        else:
            self._bot = aiogram.Bot(token=self._token)
        await self._bot.delete_webhook(drop_pending_updates=True)
        self._poll_task = asyncio.get_running_loop().create_task(self._poll_loop(), name="telegram-poll")

    async def stop(self) -> None:
        task, self._poll_task = self._poll_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        bot, self._bot = self._bot, None
        session = getattr(bot, "session", None)
        close = getattr(session, "close", None)
        if callable(close):
            with contextlib.suppress(Exception):
                result = close()
                if inspect.isawaitable(result):
                    await result

    # --- inbound: SDK event → InboundMessage -----------------------------------

    async def _poll_loop(self) -> None:
        offset = 0
        while True:
            try:
                updates = await self._bot.get_updates(offset=offset, timeout=LONG_POLL_SECONDS)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # transport hiccups: log one line, keep polling
                logger.warning("gateway telegram: get_updates failed: %s", exc)
                await asyncio.sleep(POLL_ERROR_PAUSE_SECONDS)
                continue
            for update in updates:
                offset = max(offset, int(getattr(update, "update_id", 0) or 0) + 1)
                await self._deliver(update)

    async def _deliver(self, update: Any) -> None:
        message = await self._normalize_update(update)
        if message is not None and self._sink is not None:
            await self._sink.inbound(message)

    async def _normalize_update(self, update: Any) -> InboundMessage | None:
        callback = getattr(update, "callback_query", None)
        if callback is not None:
            return await self._normalize_callback(callback)
        message = getattr(update, "message", None)
        if message is not None:
            return await self._normalize_message(message)
        return None

    async def _normalize_message(self, message: Any) -> InboundMessage | None:
        chat = getattr(message, "chat", None)
        user = getattr(message, "from_user", None)
        if chat is None or user is None:
            return None
        chat_id = str(getattr(chat, "id", "") or "")
        if not chat_id:
            return None
        thread_id = getattr(message, "message_thread_id", None)  # forum topics, when present
        text = str(getattr(message, "text", None) or getattr(message, "caption", None) or "")
        return InboundMessage(
            channel=CHANNEL_ID,
            chat_id=chat_id,
            chat_type="dm" if str(getattr(chat, "type", "")) == "private" else "group",
            sender_id=str(getattr(user, "id", "") or ""),
            sender_name=_sender_name(user),
            thread_id=str(thread_id) if thread_id else None,
            text=text,
            attachments=await self._collect_attachments(message, chat_id),
            message_ref=f"{chat_id}:{getattr(message, 'message_id', '')}",
        )

    async def _normalize_callback(self, callback: Any) -> InboundMessage | None:
        """Button press → digit text so the pump's question row handles it."""
        data = str(getattr(callback, "data", "") or "")
        if not data.startswith(BUTTON_CALLBACK_PREFIX):
            return None
        try:
            index = int(data[len(BUTTON_CALLBACK_PREFIX):])
        except ValueError:
            return None
        message = getattr(callback, "message", None)
        chat = getattr(message, "chat", None)
        user = getattr(callback, "from_user", None)
        if chat is None or user is None:
            return None
        await self._answer_callback(callback)
        ref = str(getattr(callback, "id", "") or "")
        return InboundMessage(
            channel=CHANNEL_ID,
            chat_id=str(getattr(chat, "id", "") or ""),
            chat_type="dm" if str(getattr(chat, "type", "")) == "private" else "group",
            sender_id=str(getattr(user, "id", "") or ""),
            sender_name=_sender_name(user),
            thread_id=None,
            text=str(index + 1),
            attachments=(),
            message_ref=ref or f"{BUTTON_CALLBACK_PREFIX}{index}",
        )

    async def _answer_callback(self, callback: Any) -> None:
        answer = getattr(callback, "answer", None)
        if not callable(answer):
            return
        try:
            result = answer()
            if inspect.isawaitable(result):
                await result
        except Exception as exc:  # best effort; the pump still gets the answer
            logger.debug("gateway telegram: callback answer failed: %s", exc)

    def _media_sources(self, message: Any) -> list[_MediaSource]:
        sources: list[_MediaSource] = []
        photo = getattr(message, "photo", None)
        if photo:  # list of PhotoSize, largest last in practice — pick by area/size
            largest = max(
                photo,
                key=lambda size: (
                    (getattr(size, "width", 0) or 0) * (getattr(size, "height", 0) or 0),
                    getattr(size, "file_size", 0) or 0,
                ),
            )
            sources.append(_MediaSource(largest, "image", "image/jpeg", None))
        document = getattr(message, "document", None)
        if document is not None:
            content_type = str(getattr(document, "mime_type", "") or "application/octet-stream")
            sources.append(_MediaSource(document, _kind_of_content_type(content_type), content_type,
                                        getattr(document, "file_name", None)))
        voice = getattr(message, "voice", None)
        if voice is not None:
            sources.append(_MediaSource(voice, "audio", "audio/ogg", None))
        video = getattr(message, "video", None)
        if video is not None:
            content_type = str(getattr(video, "mime_type", "") or "video/mp4")
            sources.append(_MediaSource(video, _kind_of_content_type(content_type), content_type,
                                        getattr(video, "file_name", None)))
        return sources

    async def _collect_attachments(self, message: Any, chat_id: str) -> tuple[Attachment, ...]:
        sources = self._media_sources(message)
        if not sources:
            return ()
        directory = self._attachment_dir()
        saved: list[Attachment] = []
        for position, source in enumerate(sources, start=1):
            size = int(getattr(source.media, "file_size", 0) or 0)
            if size > MAX_ATTACHMENT_BYTES:
                logger.info("gateway telegram: ignored attachment over 20MB from chat %s", chat_id)
                await self._send_notice(chat_id, OVERSIZE_NOTICE)
                continue
            fallback = f"{getattr(message, 'message_id', 'file')}-{position}{_EXTENSION_FOR_KIND[source.kind]}"
            path = directory / _safe_filename(source.filename, fallback)
            try:
                await self._bot.download(source.media, destination=path)
            except Exception as exc:
                logger.warning("gateway telegram: attachment %s download failed: %s", path.name, exc)
                continue
            saved.append(Attachment(path=path, content_type=source.content_type, kind=source.kind))
        return tuple(saved)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    async def _send_notice(self, chat_id: str, text: str) -> None:
        if self._bot is None:
            return
        try:
            await self._bot.send_message(chat_id, text, parse_mode=None)
        except Exception as exc:
            logger.warning("gateway telegram: notice send failed: %s", exc)

    # --- outbound ---------------------------------------------------------------

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        bot = self._bot
        if bot is None:
            logger.warning("gateway telegram: send before start; dropping payload")
            return
        thread_id = target.thread_id
        try:
            reply_markup = self._choice_keyboard(payload.choices) if payload.choices else None
            if payload.text or reply_markup is not None:
                sent = await bot.send_message(
                    target.chat_id,
                    payload.text,
                    parse_mode=None,
                    reply_markup=reply_markup,
                    message_thread_id=thread_id,
                )
                message_id = getattr(sent, "message_id", None)
                if message_id:  # transport state: anchor for the status reaction
                    self._last_message_id[target.chat_id] = message_id
            for attachment in payload.attachments:
                await self._send_attachment(bot, target.chat_id, attachment, thread_id)
        except Exception as exc:
            logger.warning("gateway telegram: send to chat %s failed: %s", target.chat_id, exc)

    def _choice_keyboard(self, choices: tuple[str, ...]) -> Any:
        """Inline keyboard; callback_data "ans:<index>" arrives back as text "N"."""
        aiogram = self._aiogram
        rows = [
            [aiogram.InlineKeyboardButton(text=str(label), callback_data=f"{BUTTON_CALLBACK_PREFIX}{index}")]
            for index, label in enumerate(choices)
        ]
        return aiogram.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _send_attachment(self, bot: Any, chat_id: str, attachment: Attachment, thread_id: str | None) -> None:
        aiogram = self._aiogram
        source = aiogram.FSInputFile(str(attachment.path))
        if attachment.kind == "image":
            await bot.send_photo(chat_id, photo=source, message_thread_id=thread_id)
        else:
            await bot.send_document(chat_id, document=source, message_thread_id=thread_id)

    async def typing(self, target: SendTarget) -> None:
        if self._bot is None:
            return
        try:
            await self._bot.send_chat_action(target.chat_id, TYPING_ACTION, message_thread_id=target.thread_id)
        except Exception as exc:
            logger.debug("gateway telegram: chat action failed: %s", exc)

    async def react(self, target: SendTarget, emoji: str) -> None:
        """Status reaction: setMessageReaction with the pinned 👀 emoji on our
        last posted message; failures are best-effort (never raised)."""
        bot = self._bot
        message_id = self._last_message_id.get(target.chat_id)
        setter = getattr(bot, "set_message_reaction", None) if bot is not None else None
        if not message_id or not callable(setter):
            return
        try:
            await setter(target.chat_id, message_id, reaction=self._reaction_payload(), is_big=False)
        except Exception as exc:
            logger.debug("gateway telegram: reaction failed: %s", exc)

    def _reaction_payload(self) -> list[Any]:
        """ReactionTypeEmoji when the SDK provides it; plain dict otherwise."""
        factory = getattr(self._aiogram, "ReactionTypeEmoji", None)
        if factory is not None:
            return [factory(emoji=REACTION_EMOJI)]
        return [{"type": "emoji", "emoji": REACTION_EMOJI}]


def build_channel(config: ChannelConfig, uploads_root: Path) -> TelegramChannel:
    """Registry entry point: validates config, fails fast when SDK missing."""
    if not str(config.token or "").strip():
        raise ValueError("channel 'telegram' requires a non-empty token (channels.telegram.token)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    proxy = str(config.extra.get("proxy") or "").strip()
    return TelegramChannel(token=config.token.strip(), uploads_root=Path(uploads_root), proxy=proxy)


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "REACTION_EMOJI", "TelegramChannel", "build_channel"]
