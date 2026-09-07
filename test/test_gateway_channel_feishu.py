"""Feishu adapter smoke tests against a fake lark-oapi (渠道冒烟, gateway.md §9).

A fake ``lark_oapi`` module tree (top module + ``lark_oapi.ws`` +
``lark_oapi.api.im.v1`` request builders) is injected into ``sys.modules``;
the real adapter code (lazy import, client/dispatcher wiring, thread→loop
handoff, normalization, send, reaction hook) runs end to end over it — no
network, no SDK installed.  Covers: p2p/group receive_v1 events →
InboundMessage, post rich-text extraction, media download via the resources
API (oversize dropped with a one-line notice), text/image send payloads, the
✅ reaction hook, plus config validation.  Sync tests driving ``asyncio.run``.
"""

import asyncio
import json
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
from gateway.channels import feishu  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402

APP_ID, APP_SECRET = "cli_app", "appsecret"


# --- fake lark-oapi SDK ---------------------------------------------------------


def _builder_class(*fields):
    """lark-oapi style: X.builder().field(v)...build() → chainable builder."""

    class Inner:
        def __init__(self):
            self.values = {}

        def build(self):
            return self

    def _setter(name):
        def setter(self, value):
            self.values[name] = value
            return self

        return setter

    for field in fields:
        setattr(Inner, field, _setter(field))

    class Outer:
        @staticmethod
        def builder():
            return Inner()

    return Outer


class FakeLarkClient:
    """Records every im.v1 call; `resource_files` feeds message_resources_get."""

    def __init__(self):
        self.messages, self.reactions, self.images, self.files, self.resources = [], [], [], [], []
        self.resource_files = []
        self.im = SimpleNamespace(v1=SimpleNamespace(
            message=SimpleNamespace(create=self._message_create),
            message_resources_get=self._resources_get,
            message_reaction=SimpleNamespace(create=self._reaction_create),
            image=SimpleNamespace(create=self._image_create),
            file=SimpleNamespace(create=self._file_create)))

    def _message_create(self, request):
        self.messages.append(request)
        return SimpleNamespace(data={"message_id": f"om_{len(self.messages)}"})

    def _resources_get(self, request):
        self.resources.append(request)
        return SimpleNamespace(file=self.resource_files[-1], msg="ok")

    def _reaction_create(self, request):
        self.reactions.append(request)
        return SimpleNamespace(data={})

    def _image_create(self, request):
        self.images.append(request)
        return SimpleNamespace(data={"image_key": "img_key_1"})

    def _file_create(self, request):
        self.files.append(request)
        return SimpleNamespace(data={"file_key": "file_key_1"})


class FakeLarkWsClient:
    def __init__(self, app_id, app_secret, event_handler=None, **kwargs):
        self.app_id, self.app_secret, self.event_handler = app_id, app_secret, event_handler
        self.started = False

    def start(self):  # the real client blocks on its own thread; a flag is enough here
        self.started = True


class FakeEventDispatcherBuilder:
    def __init__(self, *args):
        self.handlers = {}

    def register_p2_im_message_receive_v1(self, fn):
        self.handlers["im.message.receive_v1"] = fn
        return self

    def build(self):
        return SimpleNamespace(handlers=self.handlers)


class FakeClientBuilder:
    def __init__(self):
        self.values = {}

    def app_id(self, value):
        self.values["app_id"] = value
        return self

    def app_secret(self, value):
        self.values["app_secret"] = value
        return self

    def build(self):
        client = FakeLarkClient()
        client.credentials = self.values
        return client


def make_fake_lark_oapi() -> tuple[types.ModuleType, ...]:
    lark = types.ModuleType("lark_oapi")
    lark.Client = SimpleNamespace(builder=lambda: FakeClientBuilder())
    lark.EventDispatcherHandler = SimpleNamespace(builder=FakeEventDispatcherBuilder)
    ws = types.ModuleType("lark_oapi.ws")
    ws.Client = FakeLarkWsClient
    lark.ws = ws
    im_v1 = types.ModuleType("lark_oapi.api.im.v1")
    for name, fields in {
        "CreateMessageRequest": ("receive_id_type", "request_body"),
        "CreateMessageRequestBody": ("receive_id", "msg_type", "content"),
        "MessageResourcesGetRequest": ("message_id", "file_type"),
        "CreateMessageReactionRequest": ("message_id", "request_body"),
        "CreateMessageReactionRequestBody": ("reaction_type",),
        "Emoji": ("emoji_type",),
        "CreateImageRequest": ("request_body",),
        "CreateImageRequestBody": ("image_type", "image"),
        "CreateFileRequest": ("request_body",),
        "CreateFileRequestBody": ("file_type", "file_name", "file"),
    }.items():
        setattr(im_v1, name, _builder_class(*fields))
    return lark, ws, im_v1


@pytest.fixture
def fake_lark(monkeypatch):
    modules = make_fake_lark_oapi()
    for module in modules:
        monkeypatch.setitem(sys.modules, module.__name__, module)
    return modules[0]


# --- fixture events ---------------------------------------------------------------


def _receive_event(*, chat_id="oc_chat1", chat_type="p2p", message_type="text",
                   message_id="om_in1", content=json.dumps({"text": "帮我看看 build 报错"}),
                   open_id="ou_user1"):
    message = SimpleNamespace(chat_id=chat_id, chat_type=chat_type, message_type=message_type,
                              message_id=message_id, content=content)
    sender = SimpleNamespace(sender_id=SimpleNamespace(open_id=open_id, union_id="un", user_id="u"))
    return SimpleNamespace(event=SimpleNamespace(message=message, sender=sender))


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
    config = ChannelConfig(id="feishu", extra={"app_id": APP_ID, "app_secret": APP_SECRET})
    channel = feishu.build_channel(config, tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    await _until(lambda: channel._ws_client.started)  # start() runs on the SDK thread
    assert channel._ws_client.app_id == APP_ID
    assert channel._client.credentials == {"app_id": APP_ID, "app_secret": APP_SECRET}
    assert "im.message.receive_v1" in channel._ws_client.event_handler.handlers
    return channel, sink


async def _deliver(channel, sink, event):
    channel._on_event(event)  # SDK-thread entry; schedules onto the gateway loop
    await asyncio.sleep(0.02)


# --- receive: receive_v1 event → InboundMessage --------------------------------------


def test_p2p_text_event_normalizes_to_inbound_message(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await _deliver(channel, sink, _receive_event())
        (msg,) = sink.messages
        assert msg.channel == "feishu"
        assert msg.chat_id == "oc_chat1" and msg.chat_type == "dm"  # p2p → dm
        assert msg.sender_id == "ou_user1" and msg.sender_name == "ou_user1"
        assert msg.thread_id is None and msg.text == "帮我看看 build 报错"
        assert msg.attachments == () and msg.message_ref == "om_in1"
        await channel.stop()

    asyncio.run(scenario())


def test_group_event_and_post_rich_text_extraction(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        post = json.dumps({"title": "日报", "content": [
            [{"tag": "text", "text": "第一行 "}, {"tag": "a", "text": "链接", "href": "https://x"}],
            [{"tag": "text", "text": "第二行"}, {"tag": "at", "user_id": "ou_user1"}]]})
        await _deliver(channel, sink, _receive_event(chat_id="oc_grp", chat_type="group",
                                                     message_type="post", message_id="om_in2",
                                                     content=post))
        (msg,) = sink.messages
        assert msg.chat_type == "group" and msg.chat_id == "oc_grp"
        assert msg.text == "第一行 链接\n第二行"  # text + link labels, line breaks kept, at dropped
        await channel.stop()

    asyncio.run(scenario())


def test_image_event_downloads_via_resources_api(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        channel._client.resource_files.append(b"png-bytes")
        await _deliver(channel, sink, _receive_event(message_type="image", message_id="om_in3",
                                                     content=json.dumps({"image_key": "img_k"})))
        (msg,) = sink.messages
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"png-bytes"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/feishu/<date>/
        assert attachment.path.parent.parent.name == "feishu"
        assert attachment.path.name == "om_in3.jpg"
        assert attachment.content_type == "image/jpeg" and attachment.kind == "image"
        (request,) = channel._client.resources
        assert request.values == {"message_id": "om_in3", "file_type": "image"}
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_media_is_dropped_with_one_line_notice(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        channel._client.resource_files.append(b"x" * (21 * 1024 * 1024))
        await _deliver(channel, sink, _receive_event(message_type="image", message_id="om_big"))
        (msg,) = sink.messages
        assert msg.attachments == ()
        (notice,) = channel._client.messages  # the one-line notice went out as a text message
        body = notice.values["request_body"]
        assert body.values["msg_type"] == "text"
        assert json.loads(body.values["content"])["text"].startswith("附件过大")
        await channel.stop()

    asyncio.run(scenario())


def test_malformed_events_are_dropped(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        channel._on_event(SimpleNamespace(event=None))  # no message → dropped, no crash
        channel._on_event(_receive_event(message_id=""))  # missing identity → dropped
        await asyncio.sleep(0.02)
        assert sink.messages == []
        await channel.stop()

    asyncio.run(scenario())


# --- send ------------------------------------------------------------------------


def test_send_text_payload_and_reaction_hook(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        await channel.send(SendTarget(chat_id="oc_chat1"), OutboundPayload(text="部署完成"))
        (message,) = channel._client.messages
        assert message.values["receive_id_type"] == "chat_id"
        body = message.values["request_body"]
        assert body.values["receive_id"] == "oc_chat1" and body.values["msg_type"] == "text"
        assert json.loads(body.values["content"]) == {"text": "部署完成"}
        await channel.react(SendTarget(chat_id="oc_chat1"), "✅")  # Outbound.react passes the glyph
        (reaction,) = channel._client.reactions
        assert reaction.values["message_id"] == "om_1"  # last posted message anchors the ✅
        reaction_body = reaction.values["request_body"]
        assert reaction_body.values["reaction_type"].values["emoji_type"] == "DONE"
        await channel.react(SendTarget(chat_id="oc_chat2"), "✅")  # never posted there → quiet no-op
        assert len(channel._client.reactions) == 1
        await channel.stop()

    asyncio.run(scenario())


def test_send_image_attachment_uploads_then_sends_image_message(tmp_path, fake_lark):
    async def scenario():
        channel, sink = await _start(tmp_path)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        await channel.send(SendTarget(chat_id="oc_chat1"),
                           OutboundPayload(text="", attachments=(
                               Attachment(path=media, content_type="image/png", kind="image"),)))
        (upload,) = channel._client.images
        assert upload.values["request_body"].values["image_type"] == "message"
        assert upload.values["request_body"].values["image"] == b"png"
        (message,) = channel._client.messages
        assert message.values["request_body"].values["msg_type"] == "image"
        assert json.loads(message.values["request_body"].values["content"]) == {"image_key": "img_key_1"}
        client = channel._client
        await channel.typing(SendTarget(chat_id="oc_chat1"))  # capability off: quiet no-op
        await channel.stop()
        await channel.send(SendTarget(chat_id="oc_chat1"), OutboundPayload(text="after stop"))  # dropped
        assert channel._client is None and len(client.messages) == 1

    asyncio.run(scenario())


# --- contract ----------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = feishu.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (15000, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False
    assert caps.supports_reaction is True and caps.markdown == "none"
    assert feishu.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow", "app_id", "app_secret"})


def test_build_channel_validates_config(tmp_path, fake_lark):
    with pytest.raises(ValueError, match="requires non-empty app_id, app_secret"):
        feishu.build_channel(ChannelConfig(id="feishu"), tmp_path)
    with pytest.raises(ValueError, match="requires non-empty app_secret"):
        feishu.build_channel(ChannelConfig(id="feishu", extra={"app_id": "cli"}), tmp_path)


def test_registry_disables_channel_when_sdk_missing(monkeypatch, tmp_path):
    from gateway.channels import build_channel as registry_build

    monkeypatch.setitem(sys.modules, "lark_oapi", None)
    config = ChannelConfig(id="feishu", extra={"app_id": "cli", "app_secret": "s"})
    assert registry_build("feishu", config, tmp_path) is None  # ImportError degrades to one log + None
