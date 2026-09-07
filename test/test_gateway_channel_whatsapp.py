"""WhatsApp Cloud adapter smoke tests against a fake aiohttp (渠道冒烟, §9).

A fake ``aiohttp`` module is injected into ``sys.modules``; the real adapter
code (lazy import, webhook wiring, Meta handshake, payload normalization,
Graph sends) runs end to end over it — no network.  Covers: hub.challenge
verification, text/media/caption inbound → InboundMessage, phone_number_id
mismatch rejection, media download via Graph, oversize notice, text/attachment
sends with the Cloud API envelope, plus the capabilities/config contract.
Async scenarios follow the repo convention: sync tests driving asyncio.run.
"""

import asyncio
import os
import sys
import types
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import Attachment, Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import whatsapp_cloud  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402


# --- fake aiohttp SDK ---------------------------------------------------------------

BOUND_SITES: list[tuple[str, int]] = []


class FakeWebResponse:
    def __init__(self, *, text=None, status=200):
        self.text = text
        self.status = status


class FakeRouter:
    def __init__(self):
        self.routes = {}

    def add_get(self, path, handler):
        self.routes[("GET", path)] = handler

    def add_post(self, path, handler):
        self.routes[("POST", path)] = handler


class FakeApplication:
    def __init__(self, **kwargs):
        self.router = FakeRouter()


class FakeAppRunner:
    def __init__(self, app, **kwargs):
        self.app = app
        self.set_up = False
        self.cleaned = False

    async def setup(self):
        self.set_up = True

    async def cleanup(self):
        self.cleaned = True


class FakeTCPSite:
    def __init__(self, runner, host=None, port=None, **kwargs):
        self.runner, self.host, self.port = runner, host, port
        BOUND_SITES.append((host, port))

    async def start(self):
        pass


class FakeApiResponse:
    def __init__(self, json_data=None, body=b""):
        self._json, self._body = (json_data if json_data is not None else {}), body

    async def json(self):
        return self._json

    async def read(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeClientSession:
    def __init__(self, *args, **kwargs):
        self.closed = False
        self.gets: list[dict] = []
        self.posts: list[dict] = []
        self.get_responses: list[FakeApiResponse] = []
        self.post_responses: list[FakeApiResponse] = []

    def get(self, url, params=None, headers=None):
        self.gets.append({"url": url, "params": params, "headers": headers})
        return self.get_responses.pop(0)

    def post(self, url, params=None, headers=None, json=None, data=None):
        self.posts.append({"url": url, "params": params, "headers": headers, "json": json, "data": data})
        return self.post_responses.pop(0)

    async def close(self):
        self.closed = True


class FakeFormData:
    def __init__(self):
        self.fields = []

    def add_field(self, name, value=None, filename=None, content_type=None):
        self.fields.append({"name": name, "value": value, "filename": filename, "content_type": content_type})


def make_fake_aiohttp() -> types.ModuleType:
    module = types.ModuleType("aiohttp")
    web = types.ModuleType("aiohttp.web")
    web.Application = FakeApplication
    web.AppRunner = FakeAppRunner
    web.TCPSite = FakeTCPSite
    web.Response = FakeWebResponse
    module.web = web
    module.ClientSession = FakeClientSession
    module.FormData = FakeFormData
    return module


@pytest.fixture
def fake_aiohttp(monkeypatch):
    module = make_fake_aiohttp()
    monkeypatch.setitem(sys.modules, "aiohttp", module)
    monkeypatch.setitem(sys.modules, "aiohttp.web", module.web)
    BOUND_SITES.clear()
    return module


class FakeRequest:
    def __init__(self, query=None, json_body=None):
        self.query = query or {}
        self._json = json_body

    async def json(self):
        return self._json


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


PHONE_ID, ACCESS_TOKEN, VERIFY_TOKEN = "106540352242922", "eaig-token", "verify-me"


def _config(**extra) -> ChannelConfig:
    return ChannelConfig(id="whatsapp", extra={"phone_number_id": PHONE_ID, "access_token": ACCESS_TOKEN,
                                               "verify_token": VERIFY_TOKEN, **extra})


def _payload(*messages, phone_number_id=PHONE_ID):
    return {"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": phone_number_id},
                                              "messages": list(messages)}}]}]}


async def _start(tmp_path, **extra):
    channel = whatsapp_cloud.build_channel(_config(**extra), tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    runner = channel._runner
    assert runner.set_up and ("0.0.0.0", 8080) in BOUND_SITES
    routes = runner.app.router.routes
    assert ("GET", "/webhook") in routes and ("POST", "/webhook") in routes
    return channel, sink, routes


# --- webhook verification -------------------------------------------------------------


def test_webhook_verify_echoes_challenge_only_for_matching_token(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        get = routes[("GET", "/webhook")]
        good = {"hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "CHALLENGE-42"}
        response = await get(FakeRequest(query=good))
        assert response.status == 200 and response.text == "CHALLENGE-42"
        assert (await get(FakeRequest(query={**good, "hub.verify_token": "wrong"}))).status == 403
        assert (await get(FakeRequest(query={**good, "hub.mode": "denied"}))).status == 403
        assert (await get(FakeRequest(query={**good, "hub.challenge": ""}))).status == 403
        assert sink.messages == []
        await channel.stop()

    asyncio.run(scenario())


# --- inbound ----------------------------------------------------------------------


def test_text_message_normalizes_to_inbound_message(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        post = routes[("POST", "/webhook")]
        message = {"from": "15551234567", "id": "wamid.ABC1", "type": "text",
                   "text": {"body": "帮我看看 build 报错"}}
        response = await post(FakeRequest(json_body=_payload(message)))
        assert response.status == 200 and response.text == "EVENT_RECEIVED"
        msg = sink.messages[0]
        assert msg.channel == "whatsapp"
        assert msg.chat_id == "15551234567" and msg.chat_type == "dm"
        assert msg.sender_id == "15551234567" and msg.sender_name == "15551234567"
        assert msg.thread_id is None and msg.text == "帮我看看 build 报错"
        assert msg.attachments == () and msg.message_ref == "wamid.ABC1"

        # delivery receipts (statuses only) are ignored; uninteresting types too
        await post(FakeRequest(json_body=_payload({"id": "wamid.S", "type": "reaction"})))
        await post(FakeRequest(json_body={"entry": [{"changes": [{"value": {"statuses": [{"status": "delivered"}]}}]}]}))
        assert len(sink.messages) == 1

        # another number sharing this webhook URL → rejected
        response = await post(FakeRequest(json_body=_payload(message, phone_number_id="999")))
        assert response.status == 403 and len(sink.messages) == 1
        await channel.stop()

    asyncio.run(scenario())


def test_media_message_downloads_via_graph_into_uploads_dir(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        channel._session.get_responses.extend([
            FakeApiResponse(json_data={"url": "https://lookaside.fbsbx.com/f1", "mime_type": "image/jpeg",
                                       "file_size": 4096}),
            FakeApiResponse(body=b"jpeg-bytes"),
        ])
        message = {"from": "15551234567", "id": "wamid.M1", "type": "image",
                   "image": {"id": "MEDIA-1", "mime_type": "image/jpeg", "caption": "看这张图"}}
        await routes[("POST", "/webhook")](FakeRequest(json_body=_payload(message)))
        msg = sink.messages[0]
        assert msg.text == "看这张图"  # caption stands in for text on media messages
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"jpeg-bytes"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/whatsapp/<date>/
        assert attachment.path.parent.parent.name == "whatsapp"
        assert attachment.kind == "image" and attachment.content_type == "image/jpeg"
        meta, blob = channel._session.gets
        assert meta["url"].endswith(f"/{PHONE_ID}/../MEDIA-1".split("../", 1)[1]) or meta["url"].endswith("/MEDIA-1")
        assert meta["headers"] == {"Authorization": f"Bearer {ACCESS_TOKEN}"}
        assert blob["url"] == "https://lookaside.fbsbx.com/f1" and blob["headers"] == meta["headers"]
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_media_is_ignored_with_one_line_notice(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        channel._session.get_responses.append(
            FakeApiResponse(json_data={"url": "https://lookaside.fbsbx.com/f1",
                                       "mime_type": "application/zip", "file_size": 21 * 1024 * 1024}))
        message = {"from": "15551234567", "id": "wamid.B1", "type": "document",
                   "document": {"id": "BIG-1", "filename": "huge.zip"}}
        await routes[("POST", "/webhook")](FakeRequest(json_body=_payload(message)))
        msg = sink.messages[0]
        assert msg.attachments == [] or msg.attachments == ()  # dropped before any download
        assert len(channel._session.gets) == 1  # metadata only, blob never fetched
        notice = channel._session.posts[-1]
        assert notice["json"]["to"] == "15551234567" and "20MB" in notice["json"]["text"]["body"]
        await channel.stop()

    asyncio.run(scenario())


# --- send -----------------------------------------------------------------------


def test_send_text_posts_cloud_api_envelope(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        channel._session.post_responses.append(FakeApiResponse(json_data={"messages": [{"id": "wamid.OUT1"}]}))
        await channel.send(SendTarget(chat_id="15551234567"), OutboundPayload(text="部署完成"))
        (post,) = channel._session.posts
        assert post["url"] == f"https://graph.facebook.com/v20.0/{PHONE_ID}/messages"
        assert post["headers"] == {"Authorization": f"Bearer {ACCESS_TOKEN}"}
        assert post["json"] == {"messaging_product": "whatsapp", "recipient_type": "individual",
                                "to": "15551234567", "type": "text",
                                "text": {"body": "部署完成", "preview_url": False}}
        await channel.typing(SendTarget(chat_id="15551234567"))  # capability off: quiet no-op
        session = channel._session
        await channel.stop()
        await channel.send(SendTarget(chat_id="15551234567"), OutboundPayload(text="after stop"))  # dropped
        assert len(session.posts) == 1

    asyncio.run(scenario())


def test_send_attachment_uploads_media_then_sends(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        channel._session.post_responses.extend([FakeApiResponse(json_data={"messages": [{"id": "wamid.O1"}]}),
                                                FakeApiResponse(json_data={"id": "MEDIA-OUT"}),
                                                FakeApiResponse(json_data={"messages": [{"id": "wamid.O2"}]})])
        await channel.send(SendTarget(chat_id="15551234567"),
                           OutboundPayload(text="看附件",
                                           attachments=(Attachment(path=media, content_type="image/png",
                                                                   kind="image"),)))
        text, upload, message = channel._session.posts
        assert text["json"]["type"] == "text"  # text goes out before attachments
        assert upload["url"] == f"https://graph.facebook.com/v20.0/{PHONE_ID}/media"
        names = [field["name"] for field in upload["data"].fields]
        assert names == ["file", "type", "messaging_product"]
        (file_field,) = [field for field in upload["data"].fields if field["name"] == "file"]
        assert file_field["value"] == b"png" and file_field["filename"] == "out.png"
        assert message["json"] == {"messaging_product": "whatsapp", "recipient_type": "individual",
                                   "to": "15551234567", "type": "image", "image": {"id": "MEDIA-OUT"}}
        await channel.stop()

    asyncio.run(scenario())


# --- contract ---------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = whatsapp_cloud.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (4096, "utf16")
    assert caps.supports_typing is False and caps.supports_buttons is False and caps.supports_reaction is False
    assert caps.markdown == "none"
    assert whatsapp_cloud.CONFIG_KEYS == frozenset({"allow_from", "phone_number_id", "access_token",
                                                    "verify_token", "webhook_host", "webhook_port"})


def test_build_channel_validates_config(tmp_path, fake_aiohttp):
    for missing in ("phone_number_id", "access_token", "verify_token"):
        extra = {"phone_number_id": "p", "access_token": "a", "verify_token": "v"}
        extra.pop(missing)
        with pytest.raises(ValueError, match="requires non-empty"):
            whatsapp_cloud.build_channel(ChannelConfig(id="whatsapp", extra=extra), tmp_path)


def test_build_channel_applies_webhook_host_port_defaults(tmp_path, fake_aiohttp):
    async def scenario():
        channel = whatsapp_cloud.build_channel(
            _config(webhook_host="127.0.0.1", webhook_port=9092), tmp_path / "uploads")
        await channel.start(_Sink())
        assert ("127.0.0.1", 9092) in BOUND_SITES
        await channel.stop()

    asyncio.run(scenario())


def test_stop_cleans_up_runner_and_session(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path)
        session, runner = channel._session, channel._runner
        await channel.stop()
        assert runner.cleaned and session.closed
        assert channel._runner is None and channel._session is None

    asyncio.run(scenario())
