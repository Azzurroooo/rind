"""Discord adapter smoke tests against a mocked discord.py (渠道冒烟, §9).

A fake ``discord`` module is injected into ``sys.modules``; the real adapter
code (lazy import, intent setup, on_message event, normalization, send) runs
end to end over it — no network, no SDK installed.  Covers: bot-author loop
prevention, guild/DM/thread normalization, send via channel.send, attachment
save + oversize notice, and the capabilities/config contract.  Async scenarios
follow the repo convention: sync tests driving ``asyncio.run``.
"""

import asyncio
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import discord as discord_channel  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402


# --- fake discord.py SDK ---------------------------------------------------------


class FakeIntents:
    def __init__(self):
        self.message_content = False

    @classmethod
    def default(cls):
        return cls()


class FakeClient:
    def __init__(self, intents=None):
        self.intents = intents
        self.handlers = {}
        self.channels = {}
        self.started_with = None
        self.closed = False

    def event(self, coro):
        self.handlers[coro.__name__] = coro
        return coro

    def get_channel(self, channel_id):
        return self.channels.get(channel_id)

    async def start(self, token):
        self.started_with = token
        await asyncio.sleep(3600)  # gateway connection: runs until cancelled

    async def close(self):
        self.closed = True


class FakeFile:
    def __init__(self, fp, filename=None):
        self.fp = str(fp)
        self.filename = filename


def make_fake_discord() -> types.ModuleType:
    module = types.ModuleType("discord")
    module.Intents = FakeIntents
    module.Client = FakeClient
    module.File = FakeFile
    return module


@pytest.fixture
def fake_discord(monkeypatch):
    module = make_fake_discord()
    monkeypatch.setitem(sys.modules, "discord", module)
    return module


# --- fixture objects shaped like discord.py entities ------------------------------


class _TextChannel:
    def __init__(self, cid, guild=None):
        self.id = cid
        self.guild = guild
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return SimpleNamespace(id=len(self.sent))


class _FakeAttachment:
    def __init__(self, filename, size, content_type):
        self.filename = filename
        self.size = size
        self.content_type = content_type
        self.saved_to = None

    async def save(self, destination):
        self.saved_to = Path(destination)
        self.saved_to.write_bytes(b"payload")


def _guild():
    return SimpleNamespace(id=999, name="workshop")


def _user(uid=2002, name="grace", display="Grace H", bot=False):
    return SimpleNamespace(id=uid, name=name, display_name=display, bot=bot)


def _message(mid=99, author=None, channel=None, content="", attachments=(), thread=None):
    return SimpleNamespace(id=mid, author=author or _user(), channel=channel or _TextChannel(555, _guild()),
                           content=content, attachments=list(attachments), thread=thread)


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


async def _start(tmp_path):
    channel = discord_channel.build_channel(ChannelConfig(id="discord", token="DISC-1"), tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    await asyncio.sleep(0)  # one tick: let the client task record its token
    client = channel._client
    assert isinstance(client, FakeClient) and client.started_with == "DISC-1"
    assert client.intents.message_content is True  # explicit intent, §8
    assert "on_message" in client.handlers
    return channel, client, sink


# --- receive: on_message → InboundMessage ------------------------------------------


def test_on_message_normalizes_guild_message_and_ignores_bot_authors(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        guild_channel = _TextChannel(555, _guild())
        await client.handlers["on_message"](
            _message(mid=99, author=_user(2002, "grace", "Grace H"), channel=guild_channel, content="@rind 帮我看看"))
        await _until(lambda: len(sink.messages) == 1)
        msg = sink.messages[0]
        assert msg.channel == "discord"
        assert msg.chat_id == "555" and msg.chat_type == "group"  # guild text channel = group
        assert msg.sender_id == "2002" and msg.sender_name == "Grace H"
        assert msg.thread_id is None and msg.text == "@rind 帮我看看"
        assert msg.attachments == () and msg.message_ref == "99"

        # loop prevention: every bot author (self included) is dropped pre-normalization
        await client.handlers["on_message"](
            _message(mid=100, author=_user(1, "rind", "Rind", bot=True), channel=guild_channel, content="echo"))
        assert len(sink.messages) == 1

        # DM → chat_type dm
        await client.handlers["on_message"](
            _message(mid=101, author=_user(2003, "dmguy", "DM Guy"), channel=_TextChannel(4444), content="hi"))
        await _until(lambda: len(sink.messages) == 2)
        assert sink.messages[1].chat_type == "dm"
        await channel.stop()

    asyncio.run(scenario())


def test_thread_message_carries_thread_id(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        thread_channel = _TextChannel(777, _guild())
        await client.handlers["on_message"](
            _message(mid=102, channel=thread_channel, thread=SimpleNamespace(id=777), content="in thread"))
        await _until(lambda: len(sink.messages) == 1)
        msg = sink.messages[0]
        assert msg.chat_type == "group" and msg.thread_id == "777"
        await channel.stop()

    asyncio.run(scenario())


def test_attachment_is_saved_into_uploads_dir(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        source = _FakeAttachment("crash report.txt", 1024, "text/plain")
        await client.handlers["on_message"](
            _message(mid=103, channel=_TextChannel(555, _guild()), attachments=[source], content="log attached"))
        await _until(lambda: len(sink.messages) == 1)
        (attachment,) = sink.messages[0].attachments
        assert source.saved_to is not None and attachment.path.is_file()
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/discord/<date>/
        assert attachment.path.parent.parent.name == "discord"
        assert attachment.path.name == "crash_report.txt"
        assert attachment.kind == "document" and attachment.content_type == "text/plain"
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_attachment_is_ignored_with_one_line_notice(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        guild_channel = _TextChannel(555, _guild())
        huge = _FakeAttachment("huge.zip", 21 * 1024 * 1024, "application/zip")
        await client.handlers["on_message"](_message(mid=104, channel=guild_channel, attachments=[huge], content=""))
        await _until(lambda: len(sink.messages) == 1)
        assert sink.messages[0].attachments == ()
        assert huge.saved_to is None  # never downloaded
        content, _ = guild_channel.sent[-1]
        assert "20MB" in content  # one-line notice into the source channel
        await channel.stop()

    asyncio.run(scenario())


# --- send ------------------------------------------------------------------------


def test_send_calls_channel_send_with_text_as_is(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        target_channel = _TextChannel(555)
        client.channels[555] = target_channel
        await channel.send(SendTarget(chat_id="555"), OutboundPayload(text="**完成** `ok`"))
        assert target_channel.sent == [("**完成** `ok`", {})]  # markdown "subset": chunker output sent unchanged
        await channel.stop()

    asyncio.run(scenario())


def test_send_resolves_thread_target_and_attachments(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        thread_channel = _TextChannel(777)
        client.channels[777] = thread_channel
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        from gateway import Attachment
        payload = OutboundPayload(text="看附件",
                                  attachments=(Attachment(path=media, content_type="image/png", kind="image"),))
        await channel.send(SendTarget(chat_id="555", thread_id="777"), payload)
        content, kwargs = thread_channel.sent[0]
        assert content == "看附件"
        assert thread_channel.sent[1][1]["file"].fp == str(media)  # discord.File over the saved path
        await channel.stop()

    asyncio.run(scenario())


def test_send_with_unresolvable_channel_is_dropped_not_raised(tmp_path, fake_discord):
    async def scenario():
        channel, client, sink = await _start(tmp_path)
        await channel.send(SendTarget(chat_id="404"), OutboundPayload(text="nobody home"))  # no raise
        await channel.typing(SendTarget(chat_id="555"))  # capability-off: quiet no-op
        await channel.stop()

    asyncio.run(scenario())


# --- contract ----------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = discord_channel.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (2000, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False and caps.supports_reaction is False
    assert caps.markdown == "subset"
    assert discord_channel.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow"})
