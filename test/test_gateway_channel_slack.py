"""Slack adapter smoke tests against a fake slack_bolt (渠道冒烟, gateway.md §9).

A fake ``slack_bolt`` module tree is injected into ``sys.modules``; the real
adapter code (lazy import, socket-mode wiring, event normalization, send,
reaction hook) runs end to end over it — no network, no SDK installed.
Covers: dm/group message events → InboundMessage (bot events and edit
subtypes dropped, thread_ts mapping, file download), chat_postMessage
payload, files_upload_v2 attachment, the ✅ reaction hook, plus config
validation and stop.  Async scenarios follow the repo convention: sync tests
driving ``asyncio.run``.
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

from gateway import Attachment, Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import slack  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402

APP_TOKEN, BOT_TOKEN = "xapp-TOKEN", "xoxb-TOKEN"


# --- fake slack_bolt SDK -------------------------------------------------------


class FakeAsyncWebClient:
    def __init__(self, token=None):
        self.token = token
        self.calls = []  # (method, kwargs)

    async def chat_postMessage(self, **kwargs):
        self.calls.append(("chat_postMessage", kwargs))
        return SimpleNamespace(data={"ts": f"1700000000.{len(self.calls):06d}", "channel": kwargs.get("channel")})

    async def files_upload_v2(self, **kwargs):
        self.calls.append(("files_upload_v2", kwargs))
        return SimpleNamespace(data={"files": []})

    async def reactions_add(self, **kwargs):
        self.calls.append(("reactions_add", kwargs))
        return SimpleNamespace(data={"ok": True})


class FakeAsyncApp:
    def __init__(self, token=None, **kwargs):
        self.token = token
        self.client = FakeAsyncWebClient(token)
        self.handlers = {}

    def event(self, *event_types):
        def register(fn):
            for event_type in event_types:
                self.handlers.setdefault(event_type, []).append(fn)
            return fn

        return register


class FakeAsyncSocketModeHandler:
    def __init__(self, app, app_token):
        self.app, self.app_token = app, app_token
        self.connected = self.closed = False

    async def connect_async(self):
        self.connected = True

    async def close_async(self):
        self.closed = True


def make_fake_slack_bolt() -> tuple[types.ModuleType, ...]:
    bolt = types.ModuleType("slack_bolt")
    async_app = types.ModuleType("slack_bolt.async_app")
    async_app.AsyncApp = FakeAsyncApp
    adapter = types.ModuleType("slack_bolt.adapter.socket_mode.aiohttp")
    adapter.AsyncSocketModeHandler = FakeAsyncSocketModeHandler
    bolt.async_app = async_app
    return bolt, async_app, adapter


@pytest.fixture
def fake_slack_bolt(monkeypatch):
    modules = make_fake_slack_bolt()
    for module in modules:
        monkeypatch.setitem(sys.modules, module.__name__, module)
    return modules[0]


# --- fixture events ---------------------------------------------------------------


def _message_event(**overrides):
    event = {"type": "message", "channel": "C123", "channel_type": "channel", "user": "U42",
             "text": "帮我看看 build 报错", "ts": "1700000001.000100"}
    event.update(overrides)
    return event


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


async def _start(tmp_path):
    config = ChannelConfig(id="slack", extra={"app_token": APP_TOKEN, "bot_token": BOT_TOKEN})
    channel = slack.build_channel(config, tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    return channel, sink


# --- start / lifecycle ---------------------------------------------------------------


def test_start_wires_socket_mode_and_message_handler(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        handler = channel._socket_handler
        assert isinstance(handler, FakeAsyncSocketModeHandler)
        assert handler.connected and handler.app_token == APP_TOKEN
        assert handler.app.token == BOT_TOKEN
        assert channel._client.token == BOT_TOKEN
        assert list(handler.app.handlers) == ["message"]  # message events land on our normalizer
        await channel.stop()
        assert handler.closed and channel._socket_handler is None and channel._client is None

    asyncio.run(scenario())


# --- receive: event → InboundMessage -----------------------------------------------


def test_dm_message_event_normalizes_to_inbound_message(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel._on_message(_message_event(channel="D555", channel_type="im",
                                                 user="U42", text="你好 rind"))
        (msg,) = sink.messages
        assert msg.channel == "slack"
        assert msg.chat_id == "D555" and msg.chat_type == "dm"
        assert msg.sender_id == "U42" and msg.sender_name == "U42"
        assert msg.thread_id is None and msg.text == "你好 rind"
        assert msg.attachments == () and msg.message_ref == "1700000001.000100"
        await channel.stop()

    asyncio.run(scenario())


def test_bot_events_and_edit_subtypes_are_dropped(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel._on_message(_message_event(bot_id="B1", subtype="bot_message"))
        await channel._on_message(_message_event(subtype="message_changed",
                                                 message={"text": "edited", "ts": "2"}))
        await channel._on_message(_message_event(subtype="message_deleted"))
        assert sink.messages == []  # loop prevention + no user turn in edits
        await channel.stop()

    asyncio.run(scenario())


def test_group_message_maps_thread_ts_and_downloads_file(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        fetched = []

        async def fake_fetch(url):
            fetched.append(url)
            return b"png-bytes"

        channel._fetch_bytes = fake_fetch
        event = _message_event(channel_type="group", thread_ts="1700000000.000500",
                               text="看这张图",
                               files=[{"name": "截图 build.png", "size": 1024, "mimetype": "image/png",
                                       "url_private_download": "https://files.slack.com/x.png",
                                       "url_private": "https://files.slack.com/x.png"}])
        await channel._on_message(event)
        (msg,) = sink.messages
        assert msg.chat_type == "group" and msg.thread_id == "1700000000.000500"
        assert msg.sender_name == "U42"
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"png-bytes"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/slack/<date>/
        assert attachment.path.parent.parent.name == "slack"
        assert attachment.path.name == "截图_build.png"  # sanitized, no spaces
        assert attachment.content_type == "image/png" and attachment.kind == "image"
        assert fetched == ["https://files.slack.com/x.png"]
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_file_is_ignored_with_one_line_notice(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        downloads = []

        async def fake_fetch(url):
            downloads.append(url)
            return b""

        channel._fetch_bytes = fake_fetch
        event = _message_event(files=[{"name": "huge.zip", "size": 21 * 1024 * 1024,
                                       "mimetype": "application/zip",
                                       "url_private_download": "https://files.slack.com/huge.zip"}])
        await channel._on_message(event)
        (msg,) = sink.messages
        assert msg.attachments == () and downloads == []  # dropped before any download
        notice = channel._client.calls[-1]
        assert notice[0] == "chat_postMessage" and "20MB" in notice[1]["text"]
        assert notice[1]["channel"] == "C123"
        await channel.stop()

    asyncio.run(scenario())


# --- send ------------------------------------------------------------------------


def test_send_posts_text_with_thread_ts_and_records_it(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel.send(SendTarget(chat_id="C123", thread_id="1700000000.000500"),
                           OutboundPayload(text="部署到生产环境？ 1. 立即部署 2. 再等等"))
        method, kwargs = channel._client.calls[-1]
        assert method == "chat_postMessage"
        assert kwargs == {"channel": "C123", "text": "部署到生产环境？ 1. 立即部署 2. 再等等",
                          "thread_ts": "1700000000.000500"}
        assert channel._last_ts["C123"] == "1700000000.000001"  # transport state for the react hook
        await channel.stop()

    asyncio.run(scenario())


def test_send_attachment_uses_files_upload_v2(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        await channel.send(SendTarget(chat_id="C123"),
                           OutboundPayload(text="", attachments=(
                               Attachment(path=media, content_type="image/png", kind="image"),)))
        method, kwargs = channel._client.calls[-1]
        assert method == "files_upload_v2"
        assert kwargs["channel"] == "C123" and kwargs["file"] == str(media)
        assert kwargs["filename"] == "out.png"
        await channel.stop()

    asyncio.run(scenario())


def test_react_hook_adds_white_check_mark_on_last_posted_message(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel.react(SendTarget(chat_id="C123"), "✅")  # nothing posted yet → quiet no-op
        assert all(method != "reactions_add" for method, _ in channel._client.calls)
        await channel.send(SendTarget(chat_id="C123"), OutboundPayload(text="完成"))
        await channel.react(SendTarget(chat_id="C123"), "✅")  # Outbound.react passes the glyph
        method, kwargs = channel._client.calls[-1]
        assert method == "reactions_add"
        assert kwargs == {"channel": "C123", "timestamp": "1700000000.000001", "name": "white_check_mark"}
        await channel.stop()

    asyncio.run(scenario())


def test_react_falls_back_to_thread_root_when_nothing_posted(tmp_path, fake_slack_bolt):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel.react(SendTarget(chat_id="C123", thread_id="1700000000.000500"), "✅")
        method, kwargs = channel._client.calls[-1]
        assert method == "reactions_add" and kwargs["timestamp"] == "1700000000.000500"
        await channel.typing(SendTarget(chat_id="C123"))  # capability off: quiet no-op
        calls = channel._client.calls
        await channel.stop()
        await channel.send(SendTarget(chat_id="C123"), OutboundPayload(text="after stop"))  # dropped
        assert channel._client is None and len(calls) == 1

    asyncio.run(scenario())


# --- contract ----------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = slack.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (40000, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False
    assert caps.supports_reaction is True and caps.markdown == "subset"
    assert slack.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow", "app_token", "bot_token"})


def test_build_channel_validates_config(tmp_path, fake_slack_bolt):
    with pytest.raises(ValueError, match="xapp-"):
        slack.build_channel(ChannelConfig(id="slack", extra={"bot_token": BOT_TOKEN}), tmp_path)
    with pytest.raises(ValueError, match="xapp-"):
        slack.build_channel(ChannelConfig(id="slack", extra={"app_token": "nope", "bot_token": BOT_TOKEN}), tmp_path)
    with pytest.raises(ValueError, match="xoxb-"):
        slack.build_channel(ChannelConfig(id="slack", extra={"app_token": APP_TOKEN}), tmp_path)
    with pytest.raises(ValueError, match="xoxb-"):
        slack.build_channel(ChannelConfig(id="slack", extra={"app_token": APP_TOKEN, "bot_token": "legacy"}),
                            tmp_path)
    channel = slack.build_channel(ChannelConfig(id="slack", token=BOT_TOKEN, extra={"app_token": APP_TOKEN}),
                                  tmp_path)  # bot_token may ride the common token key
    assert channel._bot_token == BOT_TOKEN and channel._app_token == APP_TOKEN


def test_registry_disables_channel_when_sdk_missing(monkeypatch, tmp_path):
    from gateway.channels import build_channel as registry_build

    monkeypatch.setitem(sys.modules, "slack_bolt", None)
    config = ChannelConfig(id="slack", extra={"app_token": APP_TOKEN, "bot_token": BOT_TOKEN})
    assert registry_build("slack", config, tmp_path) is None  # ImportError degrades to one log + None
