"""DingTalk adapter smoke tests against a fake dingtalk-stream (渠道冒烟, §9).

A fake ``dingtalk_stream`` module is injected into ``sys.modules``; the real
adapter code (lazy import, stream-client wiring, callback normalization with
the thread→loop handoff, robot oapi sends) runs end to end over it — no
network, no SDK installed.  Covers: dm/group bot callbacks → InboundMessage,
downloadUrl media (oversize dropped with a one-line notice), group/oToMessages
send payloads with sampleMarkdown, plus config validation and stop.  Sync
tests driving ``asyncio.run``.
"""

import asyncio
import json
import os
import sys
import types
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import dingtalk  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402

CLIENT_ID, CLIENT_SECRET = "ding-client", "ding-secret"


# --- fake dingtalk-stream SDK ----------------------------------------------------


class FakeCredential:
    def __init__(self, client_id, client_secret):
        self.client_id, self.client_secret = client_id, client_secret


class FakeStreamClient:
    def __init__(self, credential):
        self.credential = credential
        self.registered = []
        self.started = False

    def register_callback_handler(self, topic, handler):
        self.registered.append((topic, handler))

    def start(self):  # the real client blocks on its own thread; a flag is enough here
        self.started = True


class FakeChatBotClient:
    def __init__(self, credential):
        self.credential = credential
        self.posts = []  # (path, payload)

    async def post_json(self, path, payload):
        self.posts.append((path, payload))
        return {"success": True}


def make_fake_dingtalk_stream() -> types.ModuleType:
    module = types.ModuleType("dingtalk_stream")
    module.Credential = FakeCredential
    module.DingTalkStreamClient = FakeStreamClient
    module.ChatBotClient = FakeChatBotClient
    module.chatbot_bot_type = "CALLBACK_TAG"

    class CallbackMessage:
        def __init__(self, data=None):
            self.data = data

    module.CallbackMessage = CallbackMessage
    return module


@pytest.fixture
def fake_dingtalk(monkeypatch):
    module = make_fake_dingtalk_stream()
    monkeypatch.setitem(sys.modules, "dingtalk_stream", module)
    return module


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


async def _start(tmp_path):
    config = ChannelConfig(id="dingtalk", extra={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET})
    channel = dingtalk.build_channel(config, tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    await asyncio.sleep(0.02)  # the SDK client starts on its own thread
    return channel, sink


async def _callback(channel, data):
    callback = channel._sdk.CallbackMessage(data)  # SDK wrapper built by the (fake) module
    await channel.process(callback)  # hands off to the gateway loop internally
    await asyncio.sleep(0.02)


def _dm_data(**overrides):
    data = {"conversationId": "cid$dm1", "conversationType": "1", "senderStaffId": "staff42",
            "senderNick": "张三", "msgId": "msg_1", "text": {"content": "帮我跑个构建"}}
    data.update(overrides)
    return data


# --- start / receive: CALLBACK_TAG callback → InboundMessage ---------------------------


def test_start_registers_bot_handler_and_runs_stream_client(tmp_path, fake_dingtalk):
    async def scenario():
        channel, sink = await _start(tmp_path)
        stream = channel._stream_client
        assert isinstance(stream, FakeStreamClient) and stream.started
        assert stream.credential.client_id == CLIENT_ID
        assert stream.registered and stream.registered[0][0] == "CALLBACK_TAG"
        assert stream.registered[0][1] is channel  # the adapter itself is the handler
        await channel.stop()

    asyncio.run(scenario())


def test_dm_callback_normalizes_to_inbound_message(tmp_path, fake_dingtalk):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await _callback(channel, _dm_data())
        (msg,) = sink.messages
        assert msg.channel == "dingtalk"
        assert msg.chat_id == "cid$dm1" and msg.chat_type == "dm"  # conversationType "1" → dm
        assert msg.sender_id == "staff42" and msg.sender_name == "张三"
        assert msg.thread_id is None and msg.text == "帮我跑个构建"
        assert msg.attachments == () and msg.message_ref == "msg_1"
        await channel.stop()

    asyncio.run(scenario())


def test_group_callback_and_picture_download_url(tmp_path, fake_dingtalk, monkeypatch):
    async def scenario():
        channel, sink = await _start(tmp_path)
        fetched = []

        def fake_fetch(url):
            fetched.append(url)
            return b"png-bytes"

        channel._fetch_bytes = fake_fetch
        await _callback(channel, {
            "conversationId": "cid$group9", "conversationType": "2", "senderStaffId": "staff42",
            "senderNick": "李四", "msgId": "msg_2",
            "text": {"content": "看这张图"},
            "content": {"downloadUrl": "https://static.dingtalk.com/pic.JPG", "mediaType": "picture"}})
        (msg,) = sink.messages
        assert msg.chat_id == "cid$group9" and msg.chat_type == "group"
        assert msg.text == "看这张图"
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"png-bytes"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/dingtalk/<date>/
        assert attachment.path.parent.parent.name == "dingtalk"
        assert attachment.path.name == "msg_2.JPG"  # suffix rides the download URL
        assert attachment.content_type == "image/jpeg" and attachment.kind == "image"
        assert fetched == ["https://static.dingtalk.com/pic.JPG"]
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_media_is_dropped_with_one_line_notice(tmp_path, fake_dingtalk, monkeypatch):
    async def scenario():
        channel, sink = await _start(tmp_path)

        def fake_fetch(url):
            return b"x" * (21 * 1024 * 1024)

        channel._fetch_bytes = fake_fetch
        await _callback(channel, _dm_data(msgId="msg_big",
                                          content={"downloadUrl": "https://static.dingtalk.com/big.zip"}))
        (msg,) = sink.messages
        assert msg.attachments == ()
        path, payload = channel._chatbot.posts[-1]
        assert path == dingtalk.DIRECT_SEND_API  # notice goes to the dm sender
        assert json.loads(payload["msgParam"])["content"].startswith("附件过大")
        await channel.stop()

    asyncio.run(scenario())


def test_callbacks_without_identity_are_dropped(tmp_path, fake_dingtalk):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await _callback(channel, {"conversationId": "cid", "conversationType": "1"})  # no staffId/msgId
        assert sink.messages == []
        await channel.stop()

    asyncio.run(scenario())


# --- send: robot oapi ----------------------------------------------------------------


def test_group_send_uses_group_messages_api_with_sample_markdown(tmp_path, fake_dingtalk):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel.send(SendTarget(chat_id="cid$group9"), OutboundPayload(text="部署到生产环境？\n1. 立即部署"))
        (path, payload) = channel._chatbot.posts[-1]
        assert path == dingtalk.GROUP_SEND_API
        assert payload["robotCode"] == CLIENT_ID
        assert payload["openConversationId"] == "cid$group9"
        assert payload["msgKey"] == "sampleMarkdown"  # native markdown subset
        msg_param = json.loads(payload["msgParam"])
        assert msg_param["content"] == "部署到生产环境？\n1. 立即部署"
        assert msg_param["title"] == "部署到生产环境？"  # first line becomes the card title
        await channel.stop()

    asyncio.run(scenario())


def test_send_after_dm_inbound_targets_the_staff_via_o_to_messages(tmp_path, fake_dingtalk):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await _callback(channel, _dm_data())  # teaches the adapter the dm sender
        await channel.send(SendTarget(chat_id="cid$dm1"), OutboundPayload(text="构建完成"))
        (path, payload) = channel._chatbot.posts[-1]
        assert path == dingtalk.DIRECT_SEND_API
        assert payload["userIds"] == ["staff42"]  # dm targets the staff, not the conversation
        assert payload["robotCode"] == CLIENT_ID and payload["msgKey"] == "sampleMarkdown"
        await channel.typing(SendTarget(chat_id="cid$dm1"))  # capability off: quiet no-op
        chatbot = channel._chatbot
        await channel.stop()
        await channel.send(SendTarget(chat_id="cid$dm1"), OutboundPayload(text="after stop"))  # dropped
        assert channel._chatbot is None and len(chatbot.posts) == 1

    asyncio.run(scenario())


# --- contract ------------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = dingtalk.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (5000, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False
    assert caps.supports_reaction is False and caps.markdown == "subset"
    assert dingtalk.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow",
                                              "client_id", "client_secret"})


def test_build_channel_validates_config(tmp_path, fake_dingtalk):
    with pytest.raises(ValueError, match="requires non-empty client_id, client_secret"):
        dingtalk.build_channel(ChannelConfig(id="dingtalk"), tmp_path)
    with pytest.raises(ValueError, match="requires non-empty client_secret"):
        dingtalk.build_channel(ChannelConfig(id="dingtalk", extra={"client_id": "c"}), tmp_path)


def test_registry_disables_channel_when_sdk_missing(monkeypatch, tmp_path):
    from gateway.channels import build_channel as registry_build

    monkeypatch.setitem(sys.modules, "dingtalk_stream", None)
    config = ChannelConfig(id="dingtalk", extra={"client_id": "c", "client_secret": "s"})
    assert registry_build("dingtalk", config, tmp_path) is None  # ImportError degrades to one log + None
