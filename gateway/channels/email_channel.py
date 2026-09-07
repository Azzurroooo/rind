"""Email channel (gateway.md §8, plan §5.6 P2): IMAP inbound + SMTP replies.

Transport: IMAP IDLE (falling back to interval poll) + SMTP.  Optional deps
``imapclient`` and ``aiosmtplib`` (requirements-gateway.txt), lazy-imported in
:func:`build_channel`/:meth:`EmailChannel.start` — a missing SDK disables only
this channel with a one-line log (§1).  imapclient is synchronous, so IMAP
work runs in worker threads (``asyncio.to_thread``).
§8 scope only: unseen mail → ``InboundMessage`` (attachments under
``<uploads>/email/<date>/``), replies via SMTP, capability/config constants,
start/stop.  Session logic, retries, chunking and auth (allowlist/pairing
stays in security.py) live in the pump/core.  Two in-memory transport bits:
the IMAP connection and the thread_id → last Message-ID map used for
In-Reply-To on replies (transport threading, not session state).
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import logging
import os
import re
from datetime import datetime
from email import encoders, policy
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.parser import BytesParser
from email.utils import parseaddr
from pathlib import Path
from typing import Any

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "email"
CONFIG_KEYS = frozenset(
    {"allow_from", "imap_host", "imap_port", "imap_ssl", "smtp_host", "smtp_port", "smtp_starttls",
     "username", "password", "mailbox", "poll_interval"}
)

CAPABILITIES = ChannelCapabilities(
    max_text_length=60000,
    len_unit="chars",
    supports_typing=False,
    supports_buttons=False,
    supports_reaction=False,
    markdown="none",
)

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"
DEFAULT_MAILBOX = "INBOX"
DEFAULT_POLL_INTERVAL = 30
FALLBACK_SUBJECT = "来自 rind 的消息"
_SUBJECT_PREFIX = re.compile(r"^(?:(?:re|fw|fwd)(?:\[\d+\])?\s*:\s*)+", re.IGNORECASE)


def _load_sdk() -> dict[str, Any]:
    """Import imapclient + aiosmtplib; ImportError text names the fix (§1 log)."""
    try:
        imapclient = importlib.import_module("imapclient")
        aiosmtplib = importlib.import_module("aiosmtplib")
    except ImportError as exc:
        raise ImportError(
            f"channel 'email' requires imapclient>=2.3 and aiosmtplib>=3.0 ({exc}); install them to enable the channel"
        ) from exc
    return {"imapclient": imapclient, "aiosmtplib": aiosmtplib}


def normalize_subject(subject: str) -> str:
    """Subject base for thread_id: strip Re:/Fwd: prefixes, collapse, lowercase."""
    base = _SUBJECT_PREFIX.sub("", str(subject or ""))
    return re.sub(r"\s+", " ", base).strip().lower()


def _kind_of_content_type(content_type: str) -> str:
    return ("image" if content_type.startswith("image/") else
            "audio" if content_type.startswith("audio/") else
            "video" if content_type.startswith("video/") else "document")


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "")).strip()).strip("._")
    return name or fallback


def _body_text(message: Any) -> str:
    """First text/plain body part, ignoring attachment parts."""
    if not message.is_multipart():
        return str(message.get_content()) if message.get_content_type() == "text/plain" else ""
    return next((str(part.get_content()) for part in message.walk()
                 if part.get_content_type() == "text/plain" and not part.get_filename()), "")


def _attachments(message: Any) -> list[tuple[str, str, bytes]]:
    return [(str(part.get_filename()), str(part.get_content_type() or "application/octet-stream"),
             bytes(part.get_payload(decode=True) or b""))
            for part in message.walk() if part.get_filename()]


class EmailChannel:
    """IMAP poll/IDLE + SMTP adapter; ``start(sink)`` begins the poll loop."""

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, imap_host: str, smtp_host: str, username: str, password: str, uploads_root: Path,
                 imap_port: int | None = None, imap_ssl: bool = True, smtp_port: int | None = None,
                 smtp_starttls: bool = False, mailbox: str = DEFAULT_MAILBOX,
                 poll_interval: int = DEFAULT_POLL_INTERVAL) -> None:
        self._imap_host = imap_host
        self._imap_port = imap_port or (993 if imap_ssl else 143)
        self._imap_ssl = imap_ssl
        self._smtp_host = smtp_host
        self._smtp_port = smtp_port or (587 if smtp_starttls else 25)
        self._smtp_starttls = smtp_starttls
        self._username = username
        self._password = password
        self._mailbox = mailbox
        self._poll_interval = poll_interval
        self._uploads_root = Path(uploads_root)
        self._sink: Any = None
        self._sdk: dict[str, Any] | None = None
        self._imap: Any = None
        self._idle_supported = False
        self._thread_refs: dict[str, tuple[str, str]] = {}  # thread_id → (last Message-ID, original subject)
        self._poll_task: asyncio.Task[None] | None = None

    async def start(self, sink: Any) -> None:
        self._sink = sink
        self._sdk = self._sdk or _load_sdk()
        self._poll_task = asyncio.get_running_loop().create_task(self._poll_loop(), name="email-poll")

    async def stop(self) -> None:
        task, self._poll_task = self._poll_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._reset_imap()

    async def _poll_loop(self) -> None:
        while True:
            try:
                for item in await asyncio.to_thread(self._fetch_unseen):
                    await self._deliver(item)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # transport hiccup: log one line, reconnect next cycle
                logger.warning("gateway email: poll failed: %s", exc)
                await self._reset_imap()
            if self._idle_supported:
                try:
                    await asyncio.to_thread(self._idle_wait, self._poll_interval)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("gateway email: idle failed: %s", exc)
                continue
            await asyncio.sleep(self._poll_interval)

    def _ensure_imap(self) -> Any:
        if self._imap is None:
            client = self._sdk["imapclient"].IMAPClient(self._imap_host, port=self._imap_port, ssl=self._imap_ssl)
            client.login(self._username, self._password)
            client.select_folder(self._mailbox)
            self._idle_supported = "IDLE" in (client.capabilities() or [])
            self._imap = client
        return self._imap

    async def _reset_imap(self) -> None:
        client, self._imap = self._imap, None
        if client is not None:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(client.logout)

    def _idle_wait(self, timeout: float) -> None:
        imap = self._imap
        if imap is None:
            return
        with imap.idle():
            imap.idle_check(timeout=timeout)

    def _fetch_unseen(self) -> list[dict[str, Any]]:
        imap = self._ensure_imap()
        uids = imap.search(["UNSEEN"])
        items: list[dict[str, Any]] = []
        for uid, data in (imap.fetch(uids, ["RFC822"]) if uids else {}).items():
            raw = _rfc822_of(data)
            if not raw:
                continue
            message = BytesParser(policy=policy.default).parsebytes(raw)
            name, address = parseaddr(str(message.get("From", "") or ""))
            if not address:
                continue
            items.append({
                "address": address, "name": name or address,
                "message_ref": str(message.get("Message-ID", "") or "").strip() or f"uid-{uid}",
                "thread_id": normalize_subject(str(message.get("Subject", "") or "")),
                "subject": str(message.get("Subject", "") or ""),
                "body": _body_text(message), "attachments": _attachments(message),
            })
        return items

    async def _deliver(self, item: dict[str, Any]) -> None:
        directory = self._attachment_dir()
        saved: list[Attachment] = []
        for position, (filename, content_type, payload) in enumerate(item["attachments"], start=1):
            if len(payload) > MAX_ATTACHMENT_BYTES:
                logger.info("gateway email: ignored attachment over 20MB from %s", item["address"])
                await self._send_notice(item["address"], item["subject"], OVERSIZE_NOTICE)
                continue
            fallback = f"{item['message_ref']}-{position}.bin"
            path = directory / _safe_filename(filename, fallback)
            path.write_bytes(payload)
            saved.append(Attachment(path=path, content_type=content_type, kind=_kind_of_content_type(content_type)))
        self._thread_refs[item["thread_id"]] = (item["message_ref"], item["subject"])
        if self._sink is not None:
            await self._sink.inbound(InboundMessage(
                channel=CHANNEL_ID, chat_id=item["address"], chat_type="dm", sender_id=item["address"],
                sender_name=item["name"], thread_id=item["thread_id"], text=item["body"],
                attachments=tuple(saved), message_ref=item["message_ref"]))
    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        try:
            await self._send_mail(target.chat_id, target.thread_id, payload.text, payload.attachments)
            # choices: no native buttons (capabilities) — pump already rendered the numbered list
        except Exception as exc:
            logger.warning("gateway email: reply to %s failed: %s", target.chat_id, exc)

    async def _send_mail(self, to: str, thread_id: str | None, text: str,
                         attachments: tuple[Attachment, ...] = ()) -> None:
        message = MIMEMultipart()
        message["From"] = self._username
        message["To"] = to
        original_subject = self._thread_refs.get(thread_id or "", ("", ""))[1]
        message["Subject"] = (original_subject if _SUBJECT_PREFIX.match(original_subject)
                              else f"Re: {original_subject}") if original_subject else FALLBACK_SUBJECT
        if text:
            message.attach(MIMEText(text, "plain", "utf-8"))
        for attachment in attachments:
            maintype, _, subtype = (attachment.content_type or "application/octet-stream").partition("/")
            if not maintype:
                maintype = "application"
            if not subtype:
                subtype = "octet-stream"
            part = MIMEBase(maintype, subtype)
            part.set_payload(attachment.path.read_bytes())
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=attachment.path.name)
            message.attach(part)
        if thread_id and thread_id in self._thread_refs:  # transport threading (In-Reply-To), per §8 note
            message["In-Reply-To"] = self._thread_refs[thread_id][0]
        await self._sdk["aiosmtplib"].send(message, hostname=self._smtp_host, port=self._smtp_port,
                                           username=self._username, password=self._password,
                                           start_tls=self._smtp_starttls)

    async def _send_notice(self, to: str, subject: str, text: str) -> None:
        with contextlib.suppress(Exception):
            await self._send_mail(to, normalize_subject(subject), text)


def _rfc822_of(data: Any) -> bytes | None:
    """imapclient fetch maps: {uid: {b'RFC822': bytes}} or {uid: [(b'RFC822', bytes)]}."""
    value = data.get(b"RFC822") if isinstance(data, dict) else next(
        (item[1] for item in data if isinstance(item, tuple) and item[0] == b"RFC822"), None)
    return value if isinstance(value, bytes) else None


def build_channel(config: ChannelConfig, uploads_root: Path) -> EmailChannel:
    """Registry entry point: validates config, fails fast when an SDK is missing."""
    extra = config.extra
    values = {key: str(extra.get(key, "") or "").strip()
              for key in ("imap_host", "smtp_host", "username", "password")}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ValueError(f"channel 'email' requires non-empty {', '.join(missing)} (channels.email.<key>)")
    _load_sdk()  # §1: ImportError here disables just this channel, one log line
    return EmailChannel(
        imap_host=values["imap_host"], smtp_host=values["smtp_host"],
        username=values["username"], password=values["password"], uploads_root=Path(uploads_root),
        imap_port=extra.get("imap_port"), imap_ssl=bool(extra.get("imap_ssl", True)),
        smtp_port=extra.get("smtp_port"), smtp_starttls=bool(extra.get("smtp_starttls", False)),
        mailbox=str(extra.get("mailbox", "") or DEFAULT_MAILBOX),
        poll_interval=int(extra.get("poll_interval") or DEFAULT_POLL_INTERVAL),
    )


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "EmailChannel", "build_channel", "normalize_subject"]
