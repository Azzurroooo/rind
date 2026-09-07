"""WeCom adapter smoke tests against a fake aiohttp (渠道冒烟, gateway.md §9).

A fake ``aiohttp`` module is injected into ``sys.modules``; the real adapter
code (lazy import, callback server wiring, signature/AES verification,
normalization, send) runs end to end over it — no network.  The WeCom crypto
(sha1 signature + AES-256-CBC decrypt) is exercised with REAL cryptography:
tests generate an encoding_aes_key, encrypt echostr/messages with the WeCom
payload layout, and assert the channel decrypts them.  Async scenarios follow
the repo convention: sync tests driving ``asyncio.run``.
"""

import asyncio
import base64
import hashlib
import os
import sys
import types
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from cryptography.hazmat.primitives import padding as real_padding  # noqa: E402
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: E402

from gateway import Attachment, Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import wecom  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402


# --- WeCom crypto helpers (real AES, test-side encryption) -------------------------


def _make_aes_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()[:43]


def _wecom_encrypt(encoding_aes_key: str, plaintext: str, receive_id: str) -> str:
    key = base64.b64decode(encoding_aes_key + "=")
    payload = (os.urandom(16) + len(plaintext.encode()).to_bytes(4, "big")
               + plaintext.encode() + receive_id.encode())
    padder = real_padding.PKCS7(256).padder()
    padded = padder.update(payload) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).encryptor()
    return base64.b64encode(encryptor.update(padded) + encryptor.finalize()).decode()


def _signature(token: str, *parts: str) -> str:
    return hashlib.sha1("".join(sorted((token, *parts))).encode()).hexdigest()


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
    def __init__(self, query=None, text=""):
        self.query = query or {}
        self._text = text

    async def text(self):
        return self._text


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


# --- fixtures shaped like WeCom callback traffic ------------------------------------

CORP_ID, AGENT_ID, SECRET, CALLBACK_TOKEN = "corp-1", 1000002, "s3cret", "TOKEN-1"


def _config(aes_key: str) -> ChannelConfig:
    return ChannelConfig(id="wecom", token=CALLBACK_TOKEN,
                         extra={"corp_id": CORP_ID, "agent_id": AGENT_ID, "secret": SECRET,
                                "encoding_aes_key": aes_key})


def _query(aes_key, payload, *, token=CALLBACK_TOKEN, nonce="n-1", timestamp="1700000000", sig=None):
    encrypt = _wecom_encrypt(aes_key, payload, CORP_ID)
    return {"msg_signature": sig if sig is not None else _signature(token, timestamp, nonce, encrypt),
            "timestamp": timestamp, "nonce": nonce, "echostr": encrypt}, encrypt


def _message_query(aes_key, fields, **kwargs):
    """Build (query, body) for a POST callback carrying `fields` inner XML."""
    inner = "".join(f"<{tag}><![CDATA[{value}]]></{tag}>" for tag, value in fields.items())
    query, encrypt = _query(aes_key, f"<xml>{inner}</xml>", **kwargs)
    body = f"<xml><ToUserName><![CDATA[{CORP_ID}]]></ToUserName><Encrypt><![CDATA[{encrypt}]]></Encrypt>" \
           f"<AgentID>{AGENT_ID}</AgentID></xml>"
    return query, body


async def _start(tmp_path, aes_key):
    channel = wecom.build_channel(_config(aes_key), tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    runner = channel._runner
    assert runner.set_up and ("0.0.0.0", 8081) in BOUND_SITES
    routes = runner.app.router.routes
    assert ("GET", "/wecom/callback") in routes and ("POST", "/wecom/callback") in routes
    return channel, sink, routes


def _token_response():
    return FakeApiResponse(json_data={"access_token": "at-1", "expires_in": 7200})


# --- callback verification ------------------------------------------------------------


def test_verify_echoes_decrypted_echostr(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        echostr = "MZqQPvXv+plain-echostr-789="
        query, _ = _query(aes_key, echostr)
        response = await routes[("GET", "/wecom/callback")](FakeRequest(query=query))
        assert response.status == 200 and response.text == echostr

        # bad signature / wrong receiveid tail → rejected
        query, _ = _query(aes_key, echostr, sig="0" * 40)
        assert (await routes[("GET", "/wecom/callback")](FakeRequest(query=query))).status == 403
        other_key = _make_aes_key()
        query, _ = _query(other_key, echostr)  # encrypted under a different key → decrypt/tail fails
        assert (await routes[("GET", "/wecom/callback")](FakeRequest(query=query))).status == 403
        assert sink.messages == []
        await channel.stop()

    asyncio.run(scenario())


def test_text_message_normalizes_to_inbound_message(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        fields = {"FromUserName": "zhangsan", "CreateTime": "1700000001", "MsgType": "text",
                  "Content": "帮我看看 build 报错", "MsgId": "1234567890", "AgentID": str(AGENT_ID)}
        query, body = _message_query(aes_key, fields)
        response = await routes[("POST", "/wecom/callback")](FakeRequest(query=query, text=body))
        assert response.status == 200 and response.text == "success"
        msg = sink.messages[0]
        assert msg.channel == "wecom"
        assert msg.chat_id == "zhangsan" and msg.chat_type == "dm"  # self-built apps are 1:1
        assert msg.sender_id == "zhangsan" and msg.sender_name == "zhangsan"
        assert msg.thread_id is None and msg.text == "帮我看看 build 报错"
        assert msg.attachments == () and msg.message_ref == "1234567890"
        await channel.stop()

    asyncio.run(scenario())


def test_event_push_and_bad_signature_are_dropped(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        # subscribe/enter events carry no user turn but still acknowledge
        query, body = _message_query(aes_key, {"Event": "enter_chat", "FromUserName": "zhangsan",
                                               "MsgType": "event", "CreateTime": "1"})
        response = await routes[("POST", "/wecom/callback")](FakeRequest(query=query, text=body))
        assert response.status == 200 and sink.messages == []
        # tampered signature → 403, nothing delivered
        query, body = _message_query(aes_key, {"FromUserName": "zhangsan", "MsgType": "text",
                                               "Content": "hi", "MsgId": "7"}, sig="bad" * 13 + "x")
        response = await routes[("POST", "/wecom/callback")](FakeRequest(query=query, text=body))
        assert response.status == 403 and sink.messages == []
        await channel.stop()

    asyncio.run(scenario())


def test_media_message_downloads_into_uploads_dir(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        channel._session.get_responses.extend([_token_response(), FakeApiResponse(body=b"png-bytes")])
        fields = {"FromUserName": "zhangsan", "MsgType": "image", "MediaId": "MEDIA-1",
                  "PicUrl": "https://example/x.jpg", "MsgId": "55"}
        query, body = _message_query(aes_key, fields)
        await routes[("POST", "/wecom/callback")](FakeRequest(query=query, text=body))
        msg = sink.messages[0]
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"png-bytes"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/wecom/<date>/
        assert attachment.path.parent.parent.name == "wecom"
        assert attachment.kind == "image" and attachment.content_type == "image/jpeg"
        gets = channel._session.gets
        assert gets[0]["url"].endswith("/gettoken") and gets[0]["params"]["corpid"] == CORP_ID
        assert gets[1]["url"].endswith("/media/get")
        assert gets[1]["params"] == {"access_token": "at-1", "media_id": "MEDIA-1"}
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_attachment_is_ignored_with_one_line_notice(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        channel._session.get_responses.extend([_token_response(),
                                               FakeApiResponse(body=b"x" * (21 * 1024 * 1024))])
        fields = {"FromUserName": "zhangsan", "MsgType": "file", "MediaId": "BIG-1", "MsgId": "66"}
        query, body = _message_query(aes_key, fields)
        await routes[("POST", "/wecom/callback")](FakeRequest(query=query, text=body))
        msg = sink.messages[0]
        assert msg.attachments == ()  # dropped
        notice = channel._session.posts[-1]
        assert notice["url"].endswith("/message/send") and "20MB" in notice["json"]["text"]["content"]
        assert notice["json"]["touser"] == "zhangsan"
        await channel.stop()

    asyncio.run(scenario())


# --- send -----------------------------------------------------------------------


def test_send_text_uses_message_send_and_caches_access_token(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        channel._session.get_responses.append(_token_response())
        channel._session.post_responses.extend([FakeApiResponse(json_data={"errcode": 0}),
                                                FakeApiResponse(json_data={"errcode": 0})])
        await channel.send(SendTarget(chat_id="zhangsan"), OutboundPayload(text="部署完成"))
        await channel.send(SendTarget(chat_id="zhangsan"), OutboundPayload(text="第二次"))
        first = channel._session.posts[0]
        assert first["url"] == "https://qyapi.weixin.qq.com/cgi-bin/message/send"
        assert first["params"] == {"access_token": "at-1"}
        assert first["json"] == {"touser": "zhangsan", "msgtype": "text", "agentid": AGENT_ID,
                                 "text": {"content": "部署完成"}}
        assert len(channel._session.gets) == 1  # token cached across sends (transport auth)
        await channel.typing(SendTarget(chat_id="zhangsan"))  # capability off: quiet no-op
        session = channel._session
        await channel.stop()
        await channel.send(SendTarget(chat_id="zhangsan"), OutboundPayload(text="after stop"))  # dropped
        assert len(session.posts) == 2

    asyncio.run(scenario())


def test_send_attachment_uploads_media_then_sends_file(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        channel, sink, routes = await _start(tmp_path, aes_key)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        channel._session.get_responses.append(_token_response())
        channel._session.post_responses.extend([FakeApiResponse(json_data={"errcode": 0}),
                                                FakeApiResponse(json_data={"media_id": "M-1"}),
                                                FakeApiResponse(json_data={"errcode": 0})])
        await channel.send(SendTarget(chat_id="zhangsan"),
                           OutboundPayload(text="看附件",
                                           attachments=(Attachment(path=media, content_type="image/png",
                                                                   kind="image"),)))
        text, upload, message = channel._session.posts[0], channel._session.posts[1], channel._session.posts[2]
        assert text["json"]["msgtype"] == "text"  # text goes out before attachments
        assert upload["url"].endswith("/media/upload")
        assert upload["params"] == {"access_token": "at-1", "type": "image"}
        (field,) = upload["data"].fields
        assert field["name"] == "media" and field["value"] == b"png" and field["filename"] == "out.png"
        assert message["json"] == {"touser": "zhangsan", "msgtype": "image", "agentid": AGENT_ID,
                                   "image": {"media_id": "M-1"}}
        await channel.stop()

    asyncio.run(scenario())


# --- contract ---------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = wecom.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (2048, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False and caps.supports_reaction is False
    assert caps.markdown == "none"
    assert wecom.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow", "corp_id", "agent_id",
                                           "secret", "encoding_aes_key", "callback_host", "callback_port"})


def test_build_channel_validates_config(tmp_path, fake_aiohttp):
    aes_key = _make_aes_key()
    for missing in ("corp_id", "agent_id", "secret", "encoding_aes_key"):
        extra = {"corp_id": "c", "agent_id": "1", "secret": "s", "encoding_aes_key": aes_key}
        extra.pop(missing)
        with pytest.raises(ValueError, match="requires non-empty"):
            wecom.build_channel(ChannelConfig(id="wecom", token="t", extra=extra), tmp_path)
    with pytest.raises(ValueError, match="token"):
        wecom.build_channel(ChannelConfig(id="wecom", token="  ", extra={"corp_id": "c", "agent_id": "1",
                                                                         "secret": "s", "encoding_aes_key": aes_key}), tmp_path)
    with pytest.raises(ValueError, match="agent_id must be an integer"):
        wecom.build_channel(ChannelConfig(id="wecom", token="t", extra={"corp_id": "c", "agent_id": "abc",
                                                                        "secret": "s", "encoding_aes_key": aes_key}), tmp_path)
    with pytest.raises(ValueError, match="encoding_aes_key"):
        wecom.build_channel(ChannelConfig(id="wecom", token="t", extra={"corp_id": "c", "agent_id": "1",
                                                                        "secret": "s", "encoding_aes_key": "too-short"}), tmp_path)


def test_build_channel_applies_callback_host_port_defaults(tmp_path, fake_aiohttp):
    async def scenario():
        aes_key = _make_aes_key()
        config = ChannelConfig(id="wecom", token="t", extra={"corp_id": "c", "agent_id": "1", "secret": "s",
                                                             "encoding_aes_key": aes_key,
                                                             "callback_host": "127.0.0.1", "callback_port": 9091})
        channel = wecom.build_channel(config, tmp_path / "uploads")
        await channel.start(_Sink())
        assert ("127.0.0.1", 9091) in BOUND_SITES
        await channel.stop()

    asyncio.run(scenario())


def test_stop_cleans_up_runner_and_session(tmp_path, fake_aiohttp):
    async def scenario():
        channel, sink, routes = await _start(tmp_path, _make_aes_key())
        session, runner = channel._session, channel._runner
        await channel.stop()
        assert runner.cleaned and session.closed
        assert channel._runner is None and channel._session is None

    asyncio.run(scenario())
