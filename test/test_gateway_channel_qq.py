"""QQ adapter smoke tests over a REAL loopback reverse-WS (渠道冒烟, gateway.md §9).

QQ's "SDK" is the repo's own ``websockets`` library, so these tests run the
real stack: the adapter serves its OneBot v11 endpoint on an ephemeral port
and a fake NapCat implementation connects out.  Covers: handshake gating
(wrong path → 404, wrong/missing token → 401, correct bearer accepted),
private/group message events (CQ string and segment-array forms) →
InboundMessage with CQ image attachments, the get_image echo fallback, action
dispatch (send_private_msg / send_group_msg) with echo-id response matching,
plus config validation and stop.  Sync tests driving ``asyncio.run``.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from websockets.asyncio.client import connect as ws_connect  # noqa: E402
from websockets.exceptions import InvalidStatus  # noqa: E402

from gateway import Attachment, Channel, OutboundPayload, SendTarget  # noqa: E402
from gateway.channels import qq  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402

TOKEN = "sekret-token"


class _Sink:
    def __init__(self):
        self.messages = []

    async def inbound(self, message):
        self.messages.append(message)


async def _channel(tmp_path, **extra):
    channel = qq.build_channel(ChannelConfig(id="qq", extra={"ws_port": 0, **extra}), tmp_path / "uploads")
    assert isinstance(channel, Channel)
    sink = _Sink()
    await channel.start(sink)
    port = channel._server.sockets[0].getsockname()[1]
    url = f"ws://127.0.0.1:{port}{channel._ws_path}"
    return channel, sink, url


async def _recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def _until(predicate, timeout=2.0, message="condition not met"):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError(message)
        await asyncio.sleep(0.005)


# --- handshake gate ------------------------------------------------------------------


def test_handshake_rejects_wrong_path_and_wrong_token_then_accepts_bearer(tmp_path):
    async def scenario():
        channel, sink, url = await _channel(tmp_path, access_token=TOKEN)
        with pytest.raises(InvalidStatus) as wrong_path:
            async with ws_connect(url.replace("/onebot/v11", "/other")) as ws:
                pass
        assert wrong_path.value.response.status_code == 404
        with pytest.raises(InvalidStatus) as no_token:
            async with ws_connect(url) as ws:
                pass
        assert no_token.value.response.status_code == 401
        with pytest.raises(InvalidStatus) as bad_token:
            async with ws_connect(url, additional_headers={"Authorization": "Bearer wrong"}) as ws:
                pass
        assert bad_token.value.response.status_code == 401
        async with ws_connect(url, additional_headers={"Authorization": f"Bearer {TOKEN}"}) as ws:
            await ws.send(json.dumps({"post_type": "meta_event", "meta_event_type": "heartbeat"}))
        await asyncio.sleep(0.05)
        assert sink.messages == []  # handshake fine; heartbeats carry no user turn
        await channel.stop()

    asyncio.run(scenario())


def test_handshake_open_when_no_access_token_configured(tmp_path):
    async def scenario():
        channel, sink, url = await _channel(tmp_path)
        async with ws_connect(url) as ws:
            await ws.send("not-json")
            await asyncio.sleep(0.05)
        assert sink.messages == []  # bad frame logged, connection stays up
        await channel.stop()

    asyncio.run(scenario())


# --- receive: OneBot event → InboundMessage -------------------------------------------


def test_private_message_with_cq_image_normalizes_to_inbound(tmp_path, monkeypatch):
    async def scenario():
        channel, sink, url = await _channel(tmp_path, access_token=TOKEN)
        fetched = []

        def fake_url_read(request):
            fetched.append(request.full_url)
            return b"png-bytes"

        monkeypatch.setattr(qq, "_url_read", fake_url_read)
        async with ws_connect(url, additional_headers={"Authorization": f"Bearer {TOKEN}"}) as ws:
            await ws.send(json.dumps({
                "post_type": "message", "message_type": "private", "user_id": 10001, "message_id": 501,
                "message": "look [CQ:image,file=abc.image,url=http://qqimg.example/abc.png]",
                "sender": {"nickname": "Zhang"}}))
            await _until(lambda: len(sink.messages) == 1)
        (msg,) = sink.messages
        assert msg.channel == "qq"
        assert msg.chat_id == "10001" and msg.chat_type == "dm"
        assert msg.sender_id == "10001" and msg.sender_name == "Zhang"
        assert msg.thread_id is None and msg.text == "look "  # CQ codes stripped, text kept verbatim
        (attachment,) = msg.attachments
        assert attachment.path.is_file() and attachment.path.read_bytes() == b"png-bytes"
        assert attachment.path.parent.parent.parent == tmp_path / "uploads"  # <uploads>/qq/<date>/
        assert attachment.path.parent.parent.name == "qq"
        assert attachment.content_type == "image/jpeg" and attachment.kind == "image"
        assert fetched == ["http://qqimg.example/abc.png"]
        assert msg.message_ref == "501"
        await channel.stop()

    asyncio.run(scenario())


def test_group_message_array_form_and_get_image_echo_fallback(tmp_path, monkeypatch):
    async def scenario():
        channel, sink, url = await _channel(tmp_path)
        monkeypatch.setattr(qq, "_url_read", lambda request: b"late-bytes")
        async with ws_connect(url) as ws:
            await ws.send(json.dumps({
                "post_type": "message", "message_type": "group", "group_id": 20002,
                "user_id": 10001, "message_id": 502,
                "message": [{"type": "text", "data": {"text": "hello "}},
                            {"type": "image", "data": {"file": "xyz.image"}}],
                "sender": {"nickname": "NapCat"}}))
            action = await _recv(ws)  # no url → adapter resolves via get_image over the same socket
            assert action["action"] == "get_image" and action["params"] == {"file": "xyz.image"}
            assert action["echo"].startswith("rind-")
            await ws.send(json.dumps({"status": "ok", "retcode": 0, "echo": action["echo"],
                                      "data": {"url": "http://qqimg.example/xyz.png"}}))
            await _until(lambda: len(sink.messages) == 1)
        (msg,) = sink.messages
        assert msg.chat_id == "20002" and msg.chat_type == "group" and msg.text == "hello "
        (attachment,) = msg.attachments
        assert attachment.path.read_bytes() == b"late-bytes" and attachment.kind == "image"
        await channel.stop()

    asyncio.run(scenario())


def test_oversize_attachment_is_dropped_with_one_line_notice(tmp_path, monkeypatch):
    async def scenario():
        channel, sink, url = await _channel(tmp_path)
        monkeypatch.setattr(qq, "_url_read", lambda request: b"x" * (21 * 1024 * 1024))
        async with ws_connect(url) as ws:
            await ws.send(json.dumps({
                "post_type": "message", "message_type": "private", "user_id": 10001, "message_id": 503,
                "message": "[CQ:image,file=big.image,url=http://qqimg.example/big.png]",
                "sender": {"nickname": "Zhang"}}))
            notice = await _recv(ws)  # §8: one-line notice instead of the attachment
            assert notice["action"] == "send_private_msg"
            assert notice["params"]["message"][0]["data"]["text"].startswith("附件过大")
            await ws.send(json.dumps({"status": "ok", "retcode": 0, "echo": notice["echo"], "data": {}}))
            await _until(lambda: len(sink.messages) == 1)
        (msg,) = sink.messages
        assert msg.attachments == ()
        await channel.stop()

    asyncio.run(scenario())


# --- send: action dispatch with echo matching -------------------------------------------


def test_send_after_private_inbound_dispatches_send_private_msg_with_echo(tmp_path):
    async def scenario():
        channel, sink, url = await _channel(tmp_path)
        async with ws_connect(url) as ws:
            await ws.send(json.dumps({"post_type": "message", "message_type": "private",
                                      "user_id": 10001, "message_id": 510, "message": "hi",
                                      "sender": {"nickname": "Zhang"}}))
            await _until(lambda: len(sink.messages) == 1)
            send_task = asyncio.create_task(
                channel.send(SendTarget(chat_id="10001"), OutboundPayload(text="部署完成")))
            frame = await _recv(ws)
            assert frame["action"] == "send_private_msg"
            assert frame["params"] == {"user_id": 10001,
                                       "message": [{"type": "text", "data": {"text": "部署完成"}}]}
            assert frame["echo"].startswith("rind-")
            await ws.send(json.dumps({"status": "ok", "retcode": 0, "echo": frame["echo"],
                                      "data": {"message_id": 900}}))
            await asyncio.wait_for(send_task, 2.0)  # resolved by the echo response
        await channel.stop()

    asyncio.run(scenario())


def test_send_group_text_and_image_segment(tmp_path):
    async def scenario():
        channel, sink, url = await _channel(tmp_path)
        media = tmp_path / "out.png"
        media.write_bytes(b"png")
        async with ws_connect(url) as ws:
            send_task = asyncio.create_task(channel.send(  # unknown chat → group action by default
                SendTarget(chat_id="20002"),
                OutboundPayload(text="看附件", attachments=(
                    Attachment(path=media, content_type="image/png", kind="image"),))))
            frame = await _recv(ws)
            assert frame["action"] == "send_group_msg"
            assert frame["params"]["group_id"] == 20002
            assert frame["params"]["message"] == [{"type": "text", "data": {"text": "看附件"}},
                                                  {"type": "image", "data": {"file": media.as_uri()}}]
            await ws.send(json.dumps({"status": "ok", "retcode": 0, "echo": frame["echo"], "data": {}}))
            await asyncio.wait_for(send_task, 2.0)
        await channel.stop()
        await channel.send(SendTarget(chat_id="20002"), OutboundPayload(text="after stop"))  # no conn: dropped

    asyncio.run(scenario())


# --- contract -----------------------------------------------------------------------


def test_capabilities_and_config_keys_match_spec():
    caps = qq.CAPABILITIES
    assert (caps.max_text_length, caps.len_unit) == (4500, "chars")
    assert caps.supports_typing is False and caps.supports_buttons is False
    assert caps.supports_reaction is False and caps.markdown == "none"
    assert qq.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow", "ws_path", "ws_port",
                                        "access_token"})


def test_build_channel_validates_config_and_defaults(tmp_path):
    with pytest.raises(ValueError, match="ws_path"):
        qq.build_channel(ChannelConfig(id="qq", extra={"ws_path": "onebot"}), tmp_path)
    with pytest.raises(ValueError, match="ws_port must be an integer"):
        qq.build_channel(ChannelConfig(id="qq", extra={"ws_port": "8082"}), tmp_path)
    channel = qq.build_channel(ChannelConfig(id="qq"), tmp_path)
    assert channel._ws_path == "/onebot/v11" and channel._ws_port == 8082  # spec defaults
    assert channel._access_token == ""


def test_stop_closes_server_and_fails_pending(tmp_path):
    async def scenario():
        channel, sink, url = await _channel(tmp_path)
        async with ws_connect(url) as ws:
            await asyncio.sleep(0.05)
        await channel.stop()
        assert channel._server is None and channel._conn is None
        assert channel._pending == {}

    asyncio.run(scenario())
