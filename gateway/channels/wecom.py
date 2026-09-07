"""企业微信 self-built app channel (gateway.md §8, plan §5.6 P2).

Transport: HTTP callback + API (§5.6).  WeCom pushes events to a public HTTPS
callback URL, so deployment needs a public address or an intranet tunnel
pointing at ``callback_host:callback_port``; sends go through the
``message/send`` API.  Optional deps (lazy-imported): ``aiohttp`` (callback
server + API client) and ``cryptography`` (AES for the verify/decrypt flow);
a missing dependency disables only this channel with a one-line log (§1).
§8 scope only: callback event → ``InboundMessage``, ``send``, capability/
config constants, start/stop; session logic, retries, chunking, auth and
persistence live in the pump/core — the in-memory access_token cache is
transport auth, not session state.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib
import logging
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import Attachment, ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

CHANNEL_ID = "wecom"
CONFIG_KEYS = frozenset({"token", "allow_from", "group_allow", "corp_id", "agent_id", "secret",
                         "encoding_aes_key", "callback_host", "callback_port"})
CAPABILITIES = ChannelCapabilities(max_text_length=2048, len_unit="chars", supports_typing=False,
                                   supports_buttons=False, supports_reaction=False, markdown="none")

API_BASE = "https://qyapi.weixin.qq.com/cgi-bin"
CALLBACK_PATH = "/wecom/callback"
DEFAULT_CALLBACK_HOST, DEFAULT_CALLBACK_PORT = "0.0.0.0", 8081
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
OVERSIZE_NOTICE = "附件过大（单个上限 20MB），已忽略该附件。"

_KIND_EXT = {"image": ".jpg", "audio": ".ogg", "video": ".mp4", "document": ".bin"}
_KIND_CONTENT_TYPE = {"image": "image/jpeg", "audio": "audio/amr", "video": "video/mp4"}
_KIND_MSGTYPE = {"image": "image", "audio": "voice", "video": "video", "document": "file"}


def _load_aiohttp() -> Any:
    """Import aiohttp (top package + web submodule); ImportError names the fix (§1)."""
    try:
        module = importlib.import_module("aiohttp")
        importlib.import_module("aiohttp.web")  # binds aiohttp.web for attribute access
    except ImportError as exc:
        raise ImportError(f"channel 'wecom' requires aiohttp>=3.9 ({exc}); install it to enable the channel") from exc
    return module


def _load_crypto() -> None:
    """Import the AES primitives; ImportError names the fix (§1)."""
    try:
        from cryptography.hazmat.primitives import padding  # noqa: F401
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: F401
    except ImportError as exc:
        raise ImportError(f"channel 'wecom' requires cryptography>=42 ({exc}); install it to enable the channel") from exc


def _signature(token: str, *parts: str) -> str:
    """WeCom callback signature: sha1 over the lexically sorted [token, *parts]."""
    return hashlib.sha1("".join(sorted((token, *parts))).encode()).hexdigest()


def _decrypt(encoding_aes_key: str, ciphertext_b64: str, receive_id: str) -> bytes:
    """WeCom callback crypto: AES-256-CBC (IV = key[:16]), PKCS7(32); payload is
    random(16) + len(4, big-endian) + message + receive_id tail (加解密协议)."""
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    key = base64.b64decode(encoding_aes_key + "=")
    decryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).decryptor()
    unpadder = padding.PKCS7(256).unpadder()
    plain = unpadder.update(decryptor.update(base64.b64decode(ciphertext_b64)) + decryptor.finalize()) + unpadder.finalize()
    length = int.from_bytes(plain[16:20], "big")
    if plain[20 + length:] != receive_id.encode():
        raise ValueError("wecom callback receiveid mismatch")
    return plain[20:20 + length]


def _safe_filename(raw: Any, fallback: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", os.path.basename(str(raw or "")).strip()).strip("._")
    return name or fallback


class WeComChannel:
    """Callback + API adapter.  ``sink`` is the pump — the adapter's only
    outbound-to-core call is ``await sink.inbound(InboundMessage)``."""

    id = CHANNEL_ID
    capabilities = CAPABILITIES

    def __init__(self, *, corp_id: str, agent_id: int, secret: str, token: str, encoding_aes_key: str,
                 uploads_root: Path, host: str = DEFAULT_CALLBACK_HOST, port: int = DEFAULT_CALLBACK_PORT) -> None:
        self._corp_id, self._agent_id, self._secret = corp_id, agent_id, secret
        self._token, self._encoding_aes_key = token, encoding_aes_key
        self._uploads_root, self._host, self._port = Path(uploads_root), host, port
        self._sink = self._aiohttp = self._session = self._runner = None
        self._access_token, self._token_expires_at = "", 0.0

    async def start(self, sink: Any) -> None:
        self._sink = sink
        aiohttp = self._aiohttp or _load_aiohttp()
        self._aiohttp = aiohttp
        self._session = aiohttp.ClientSession()
        app = aiohttp.web.Application()
        app.router.add_get(CALLBACK_PATH, self._handle_verify)
        app.router.add_post(CALLBACK_PATH, self._handle_message)
        runner = aiohttp.web.AppRunner(app)
        await runner.setup()
        await aiohttp.web.TCPSite(runner, self._host, self._port).start()
        self._runner = runner
        logger.info("gateway wecom: callback on %s:%s%s (needs a public/tunnel URL)", self._host, self._port, CALLBACK_PATH)

    async def stop(self) -> None:
        runner, self._runner = self._runner, None
        if runner is not None:
            with contextlib.suppress(Exception):
                await runner.cleanup()
        session, self._session = self._session, None
        if session is not None:
            with contextlib.suppress(Exception):
                await session.close()

    # --- inbound: callback event → InboundMessage ------------------------------

    def _sig_matches(self, query: Any, *parts: str) -> bool:
        return _signature(self._token, str(query.get("timestamp", "") or ""),
                          str(query.get("nonce", "") or ""), *parts) == str(query.get("msg_signature", "") or "")

    async def _handle_verify(self, request: Any) -> Any:
        """URL verification: decrypt echostr and echo it back in plain text."""
        query = request.query
        echostr = str(query.get("echostr", "") or "")
        if not self._sig_matches(query, echostr):
            return self._aiohttp.web.Response(status=403)
        try:
            plain = _decrypt(self._encoding_aes_key, echostr, self._corp_id)
        except Exception as exc:
            logger.warning("gateway wecom: callback verify decrypt failed: %s", exc)
            return self._aiohttp.web.Response(status=403)
        return self._aiohttp.web.Response(text=plain.decode("utf-8"))

    async def _handle_message(self, request: Any) -> Any:
        query = request.query
        try:
            encrypt = str(ET.fromstring(await request.text()).findtext("Encrypt") or "").strip()
        except Exception as exc:
            logger.warning("gateway wecom: callback body is not XML: %s", exc)
            return self._aiohttp.web.Response(status=400)
        if not encrypt or not self._sig_matches(query, encrypt):
            return self._aiohttp.web.Response(status=403)
        try:
            fields = {str(c.tag): str(c.text or "") for c in
                      ET.fromstring(_decrypt(self._encoding_aes_key, encrypt, self._corp_id))}
        except Exception as exc:
            logger.warning("gateway wecom: callback decrypt failed: %s", exc)
            return self._aiohttp.web.Response(status=403)
        message = await self._normalize_message(fields)
        if message is not None and self._sink is not None:
            await self._sink.inbound(message)
        return self._aiohttp.web.Response(text="success")  # tells WeCom to stop retrying the push

    async def _normalize_message(self, fields: dict[str, str]) -> InboundMessage | None:
        is_event = str(fields.get("MsgType", "")).lower() == "event"
        sender = "" if is_event else str(fields.get("FromUserName", "") or "").strip()
        if not sender:  # events (subscribe/enter-chat) and anonymous pushes carry no user turn
            return None
        return InboundMessage(
            channel=CHANNEL_ID, chat_id=sender, chat_type="dm",  # self-built apps are 1:1
            sender_id=sender, sender_name=sender, thread_id=None,
            text=str(fields.get("Content", "") or ""),
            attachments=await self._collect_attachments(fields, sender),
            message_ref=str(fields.get("MsgId", "") or f"{fields.get('CreateTime', '')}:{sender}"),
        )

    async def _collect_attachments(self, fields: dict[str, str], sender: str) -> tuple[Attachment, ...]:
        media_id = str(fields.get("MediaId", "") or "")
        if not media_id:
            return ()
        kind = {"image": "image", "voice": "audio", "video": "video"}.get(str(fields.get("MsgType", "")), "document")
        path = self._attachment_dir() / _safe_filename(
            fields.get("FileName"), f"{fields.get('MsgId', 'file')}{_KIND_EXT[kind]}")
        try:
            data = await self._api_bytes("media/get", {"media_id": media_id})
        except Exception as exc:
            logger.warning("gateway wecom: attachment %s download failed: %s", path.name, exc)
            return ()
        if len(data) > MAX_ATTACHMENT_BYTES:
            logger.info("gateway wecom: ignored attachment over 20MB from %s", sender)
            with contextlib.suppress(Exception):
                await self._send_text(sender, OVERSIZE_NOTICE)
            return ()
        path.write_bytes(data)
        return (Attachment(path=path, content_type=_KIND_CONTENT_TYPE.get(kind, "application/octet-stream"), kind=kind),)

    def _attachment_dir(self) -> Path:
        directory = self._uploads_root / CHANNEL_ID / datetime.now().strftime("%Y%m%d")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    async def _get_access_token(self) -> str:
        if self._access_token and time.monotonic() < self._token_expires_at:
            return self._access_token
        async with self._session.get(f"{API_BASE}/gettoken",
                                     params={"corpid": self._corp_id, "corpsecret": self._secret}) as response:
            data = await response.json()
        token = str(data.get("access_token", "") or "")
        if not token:
            raise RuntimeError(f"wecom gettoken failed: {data.get('errmsg', 'no access_token')}")
        self._access_token = token
        self._token_expires_at = time.monotonic() + max(300, int(data.get("expires_in", 7200) or 7200) - 300)
        return token

    async def _api_json(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        token = await self._get_access_token()
        async with self._session.post(f"{API_BASE}/{endpoint}", params={"access_token": token}, json=payload) as response:
            return await response.json()

    async def _api_bytes(self, endpoint: str, params: dict[str, str]) -> bytes:
        token = await self._get_access_token()
        async with self._session.get(f"{API_BASE}/{endpoint}", params={"access_token": token, **params}) as response:
            return await response.read()

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None:
        if self._session is None:
            logger.warning("gateway wecom: send before start; dropping payload")
            return
        try:
            if payload.text:
                await self._send_text(target.chat_id, payload.text)
            for attachment in payload.attachments:  # choices: no buttons — pump rendered the numbered list
                msg_type = _KIND_MSGTYPE.get(attachment.kind, "file")
                media_id = await self._upload_media(attachment, msg_type)
                await self._api_json("message/send", {"touser": target.chat_id, "msgtype": msg_type,
                                                      "agentid": self._agent_id, msg_type: {"media_id": media_id}})
        except Exception as exc:
            logger.warning("gateway wecom: send to user %s failed: %s", target.chat_id, exc)

    async def _send_text(self, user_id: str, text: str) -> None:
        await self._api_json("message/send", {"touser": user_id, "msgtype": "text",
                                              "agentid": self._agent_id, "text": {"content": text}})

    async def _upload_media(self, attachment: Attachment, msg_type: str) -> str:
        token = await self._get_access_token()
        form = self._aiohttp.FormData()
        form.add_field("media", attachment.path.read_bytes(),
                       filename=attachment.path.name, content_type=attachment.content_type)
        async with self._session.post(f"{API_BASE}/media/upload",
                                      params={"access_token": token, "type": msg_type}, data=form) as response:
            data = await response.json()
        media_id = str(data.get("media_id", "") or "")
        if not media_id:
            raise RuntimeError(f"wecom media/upload failed: {data.get('errmsg', 'no media_id')}")
        return media_id

    async def typing(self, target: SendTarget) -> None:
        return None  # capability flag says no; Outbound never schedules us


def build_channel(config: ChannelConfig, uploads_root: Path) -> WeComChannel:
    """Registry entry point: validates config, fails fast when an SDK is missing."""
    extra = config.extra
    values = {key: str(extra.get(key, "") or "").strip()
              for key in ("corp_id", "agent_id", "secret", "encoding_aes_key")}
    token = str(config.token or "").strip()
    missing = [key for key, value in values.items() if not value] + (["token"] if not token else [])
    if missing:
        raise ValueError(f"channel 'wecom' requires non-empty {', '.join(missing)} (channels.wecom.<key>)")
    if not values["agent_id"].isdigit():
        raise ValueError("channel 'wecom' agent_id must be an integer (channels.wecom.agent_id)")
    try:
        if len(base64.b64decode(values["encoding_aes_key"] + "=", validate=True)) != 32:
            raise ValueError("encoding_aes_key must decode to 32 bytes")
    except Exception as exc:
        raise ValueError(f"channel 'wecom' encoding_aes_key is invalid: {exc}") from None
    _load_aiohttp()  # §1: ImportError here disables just this channel, one log line
    _load_crypto()
    return WeComChannel(
        corp_id=values["corp_id"], agent_id=int(values["agent_id"]), secret=values["secret"], token=token,
        encoding_aes_key=values["encoding_aes_key"], uploads_root=Path(uploads_root),
        host=str(extra.get("callback_host", "") or DEFAULT_CALLBACK_HOST),
        port=int(extra.get("callback_port") or DEFAULT_CALLBACK_PORT),
    )


__all__ = ["CAPABILITIES", "CONFIG_KEYS", "CHANNEL_ID", "WeComChannel", "build_channel"]
