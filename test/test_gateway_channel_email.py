"""Email adapter smoke tests against fake imapclient/aiosmtplib (渠道冒烟, §9).

Fake ``imapclient`` and ``aiosmtplib`` modules are injected into
``sys.modules``; the real adapter code (lazy import, IMAP fetch in worker
threads, MIME parsing, thread continuity, SMTP replies) runs end to end over
them — no network, real stdlib email parsing.  Covers: unseen mail →
InboundMessage (subject base thread_id, Message-ID message_ref, attachment
persisted under uploads/email/<date>/), IDLE-vs-poll detection, In-Reply-To
replies, oversize notice, and the capabilities/config contract.  Async
scenarios follow the repo convention: sync tests driving asyncio.run.
"""

import asyncio
import contextlib
import os
import sys
import time
import types
from email.message import EmailMessage
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import Attachment, Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import email_channel  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402


# --- fake imapclient / aiosmtplib SDKs ------------------------------------------------

CLIENT_OPTIONS = {"caps": ["IDLE"]}  # capabilities handed to the next IMAPClient


class FakeIMAPClient:
    def __init__(self, host, port=None, ssl=True):
        self.host, self.port, self.ssl = host, port, ssl
        self.caps = list(CLIENT_OPTIONS["caps"])
        self.uids: list[int] = []
        self.messages: dict[int, bytes] = {}
        self.logged_in: tuple | None = None
        self.selected: str | None = None
        self.searches: list[list] = []
        self.idle_checks: list[float] = []
        self.logged_out = False

    def login(self, user, password):
        self.logged_in = (user, password)

    def select_folder(self, mailbox):
        self.selected = mailbox

    def capabilities(self):
        return list(self.caps)

    def search(self, criteria):
        self.searches.append(list(criteria))
        return list(self.uids)

    def fetch(self, uids, data):
        # fetching RFC822 marks \Seen on a real server: drop the uid so the loop goes quiet
        return {uid: {b"RFC822": self.messages.pop(uid)} for uid in list(uids) if uid in self.messages}

    def idle(self):
        return contextlib.nullcontext()

    def idle_check(self, timeout=0):
        self.idle_checks.append(timeout)
        time.sleep(0.005)  # pace the poll loop like a real idle wait

    def logout(self):
        self.logged_out = True


SMTP_SENT: list[tuple[object, dict]] = []


async def fake_smtp_send(message, **kwargs):
    SMTP_SENT.append((message, kwargs))


def make_fake_sdk_modules() -> tuple[types.ModuleType, types.ModuleType]:
    imapclient = types.ModuleType("imapclient")
    imapclient.IMAPClient = FakeIMAPClient
    aiosmtplib = types.ModuleType("aiosmtplib")
    aiosmtplib.send = fake_smtp_send
    return imapclient, aiosmtplib


@pytest.fixture
def fake_sdk(monkeypatch):
    imapclient, aiosmtplib = make_fake_sdk_modules()
    monkeypatch.setitem(sys.modules, "imapclient", imapclient)
    monkeypatch.setitem(sys.modules, "aiosmtplib", aiosmtplib)
    SMTP_SENT.clear()
    CLIENT_OPTIONS["caps"] = ["IDLE"]
    return imapclient, aiosmtplib


def _config(**extra) -> ChannelConfig:
    base = {"imap_host": "imap.example.com", "smtp_host": "smtp.example.com",
            "username": "rind@example.com", "password": "app-password"}
    return ChannelConfig(id="email", extra={**base, **extra})


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


async def _until(predicate, timeout=2.0, message="condition not met"):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError(message)
        await asyncio.sleep(0.005)


def _raw_email(*, subject, sender, message_id, body, attachments=()):
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["Message-ID"] = message_id
    message.set_content(body)
    for filename, content_type, payload in attachments:
        maintype, _, subtype = content_type.partition("/")
        message.add_attachment(payload, maintype=maintype, subtype=subtype or "octet-stream", filename=filename)
    return message.as_bytes()


async def _start(tmp_path, **extra):
    """Build + start the channel and wait for the IMAP connection (empty inbox)."""
    channel = email_channel.build_channel(_config(**extra), tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    assert channel._sdk is not None  # lazy SDK load happened at start
    await _until(lambda: channel._imap is not None, message="IMAP connection never established")
    client = channel._imap  # poll loop reuses this connection; seed its inbox as needed
    return channel, sink, client


def _text_body(mime_message) -> str:
    part = next(part for part in mime_message.walk()
                if part.get_content_type() == "text/plain" and not part.get_filename())
    return (part.get_payload(decode=True) or b"").decode("utf-8")


# --- receive: unseen mail → InboundMessage ---------------------------------------------


def test_unseen_message_flows_to_inbound_message(tmp_path, fake_sdk):
    async def scenario():
        channel, sink, client = await _start(tmp_path)
        client.messages[1] = _raw_email(subject="Re: Build failed", sender="Ada Lovelace <ada@example.com>",
                                        message_id="<a1@example.com>", body="帮我看看这个报错",
                                        attachments=[("crash log.txt", "text/plain", b"payload")])
        client.uids = [1]
        await _until(lambda: len(sink.messages) == 1, message="poll loop never delivered the mail")
        assert client.logged_in == ("rind@example.com", "app-password") and client.selected == "INBOX"
        assert client.searches and client.searches[0] == ["UNSEEN"]
        msg = sink.messages[0]
        assert msg.channel == "email"
        assert msg.chat_id == "ada@example.com" and msg.chat_type == "dm"
        assert msg.sender_id == "ada@example.com" and msg.sender_name == "Ada Lovelace"
        assert msg.thread_id == "build failed"  # Re: prefix stripped, lowercased
        assert msg.text == "帮我看看这个报错\n"
        assert msg.message_ref == "<a1@example.com>"
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"payload"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/email/<date>/
        assert attachment.path.parent.parent.name == "email"
        assert attachment.path.name == "crash_log.txt"
        assert attachment.content_type == "text/plain" and attachment.kind == "document"
        await channel.stop()

    asyncio.run(scenario())


def test_idle_capability_gates_wait_vs_poll(tmp_path, fake_sdk):
    async def scenario():
        channel, sink, client = await _start(tmp_path)
        client.messages[1] = _raw_email(subject="hi", sender="b@x.com", message_id="<b1@x.com>", body="yo")
        client.uids = [1]
        await _until(lambda: len(sink.messages) == 1)
        assert channel._idle_supported is True  # "IDLE" in capabilities → idle wait used
        assert client.idle_checks  # loop idled instead of sleeping
        await channel.stop()

        # server without the IDLE capability → the loop falls back to interval polling
        CLIENT_OPTIONS["caps"] = []
        channel2 = email_channel.EmailChannel(
            imap_host="imap.example.com", smtp_host="smtp.example.com", username="rind@example.com",
            password="app-password", uploads_root=tmp_path / "uploads", poll_interval=0.05)
        sink2 = _Sink()
        await channel2.start(sink2)
        await _until(lambda: channel2._imap is not None, message="IMAP connection never established")
        client2 = channel2._imap
        client2.messages[1] = _raw_email(subject="hi", sender="c@x.com", message_id="<c1@x.com>", body="yo")
        client2.uids = [1]
        await _until(lambda: len(sink2.messages) == 1)
        assert channel2._idle_supported is False and client2.idle_checks == []
        await channel2.stop()

    asyncio.run(scenario())


# --- send: SMTP replies ----------------------------------------------------------------


def test_reply_sets_in_reply_to_and_reuses_subject(tmp_path, fake_sdk):
    async def scenario():
        channel, sink, client = await _start(tmp_path)
        client.messages[1] = _raw_email(subject="Build failed", sender="Ada <ada@example.com>",
                                        message_id="<a1@example.com>", body="看下")
        client.uids = [1]
        await _until(lambda: len(sink.messages) == 1)
        await channel.send(SendTarget(chat_id="ada@example.com", thread_id="build failed"),
                           OutboundPayload(text="已修复，见附件说明"))
        message, kwargs = SMTP_SENT[0]
        assert message["To"] == "ada@example.com" and message["From"] == "rind@example.com"
        assert message["Subject"] == "Re: Build failed"
        assert message["In-Reply-To"] == "<a1@example.com>"  # thread continuity via stored Message-ID
        assert _text_body(message) == "已修复，见附件说明"
        assert kwargs["hostname"] == "smtp.example.com" and kwargs["username"] == "rind@example.com"
        assert kwargs["start_tls"] is False
        await channel.stop()

    asyncio.run(scenario())


def test_reply_without_known_thread_uses_fallback_subject(tmp_path, fake_sdk):
    async def scenario():
        channel = email_channel.build_channel(_config(smtp_starttls=True, smtp_port=587), tmp_path / "uploads")
        await channel.start(_Sink())
        await channel.send(SendTarget(chat_id="new@example.com"), OutboundPayload(text="主动通知"))
        message, kwargs = SMTP_SENT[0]
        assert message["Subject"] == "来自 rind 的消息"
        assert message["In-Reply-To"] is None
        assert kwargs["start_tls"] is True and kwargs["port"] == 587
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_attachment_is_ignored_with_notice_mail(tmp_path, fake_sdk):
    async def scenario():
        channel, sink, client = await _start(tmp_path)
        client.messages[1] = _raw_email(subject="logs", sender="ada@example.com", message_id="<big@x>",
                                        body="附件太大", attachments=[("huge.zip", "application/zip",
                                                                      b"x" * (21 * 1024 * 1024))])
        client.uids = [1]
        await _until(lambda: len(SMTP_SENT) == 1)  # the one-line notice reply
        msg = sink.messages[0]
        assert msg.attachments == ()  # dropped, never written
        notice, _ = SMTP_SENT[0]
        assert "20MB" in _text_body(notice)
        await channel.stop()

    asyncio.run(scenario())


def test_send_with_attachment_builds_multipart(tmp_path, fake_sdk):
    async def scenario():
        channel, sink, client = await _start(tmp_path)
        client.messages[1] = _raw_email(subject="hi", sender="ada@example.com", message_id="<a@x>", body="yo")
        client.uids = [1]
        await _until(lambda: len(sink.messages) == 1)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        await channel.send(SendTarget(chat_id="ada@example.com", thread_id="hi"),
                           OutboundPayload(text="看附件",
                                           attachments=(Attachment(path=media, content_type="image/png",
                                                                   kind="image"),)))
        message, _ = SMTP_SENT[0]
        texts = [part for part in message.walk() if part.get_content_type() == "text/plain"]
        images = [part for part in message.walk() if part.get_content_type() == "image/png"]
        assert texts and _text_body(message) == "看附件"
        assert images and images[0].get_filename() == "out.png"
        await channel.stop()

    asyncio.run(scenario())


# --- contract ---------------------------------------------------------------------


def test_normalize_subject_strips_reply_prefixes_and_case():
    assert email_channel.normalize_subject("Re: Build failed") == "build failed"
    assert email_channel.normalize_subject("Re: Re[2]: FWD:   Build   failed ") == "build failed"
    assert email_channel.normalize_subject("新任务") == "新任务"
    assert email_channel.normalize_subject("") == ""


def test_capabilities_and_config_keys_match_spec():
    caps = email_channel.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (60000, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False and caps.supports_reaction is False
    assert caps.markdown == "none"
    assert email_channel.CONFIG_KEYS == frozenset(
        {"allow_from", "imap_host", "imap_port", "imap_ssl", "smtp_host", "smtp_port", "smtp_starttls",
         "username", "password", "mailbox", "poll_interval"})


def test_build_channel_validates_config_and_defaults(tmp_path, fake_sdk):
    for missing in ("imap_host", "smtp_host", "username", "password"):
        values = {"imap_host": "i", "smtp_host": "s", "username": "u", "password": "p"}
        values.pop(missing)
        with pytest.raises(ValueError, match="requires non-empty"):
            email_channel.build_channel(ChannelConfig(id="email", extra=values), tmp_path)
    channel = email_channel.build_channel(_config(), tmp_path / "uploads")
    assert channel._imap_port == 993 and channel._imap_ssl is True  # implicit-TLS default
    assert channel._smtp_port == 25 and channel._smtp_starttls is False
    assert channel._mailbox == "INBOX" and channel._poll_interval == 30
    custom = email_channel.build_channel(
        _config(imap_ssl=False, imap_port=143, smtp_starttls=True, smtp_port=587,
                mailbox="Archive", poll_interval=120), tmp_path / "uploads")
    assert custom._imap_port == 143 and custom._smtp_port == 587
    assert custom._mailbox == "Archive" and custom._poll_interval == 120


def test_stop_cancels_poll_and_logs_out(tmp_path, fake_sdk):
    async def scenario():
        channel, sink, client = await _start(tmp_path)
        poll_task = channel._poll_task
        await channel.stop()
        assert poll_task.cancelled() or poll_task.done()
        assert client.logged_out  # IMAP connection closed via worker thread
        assert channel._poll_task is None and channel._imap is None

    asyncio.run(scenario())
