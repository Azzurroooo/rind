"""Structural conformance for the channel layer (gateway.md §8/§9).

Cheap but load-bearing: every adapter module imports cleanly with its SDK NOT
installed (proves the lazy SDK import), declares the capability and
config-key constants the spec pins, and satisfies the Channel protocol.
The registry must degrade a broken channel (missing SDK / missing required
config / unknown id) to a one-line log + None instead of taking the gateway
down.
"""

import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import Channel, ChannelCapabilities  # noqa: E402
from gateway.channels import LOADERS, build_channel  # noqa: E402
from gateway.channels import discord as discord_channel  # noqa: E402
from gateway.channels import email_channel  # noqa: E402
from gateway.channels import telegram as telegram_channel  # noqa: E402
from gateway.channels import wecom  # noqa: E402
from gateway.channels import whatsapp_cloud  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402

sys.path.insert(0, str(PROJECT_ROOT / "test"))  # reuse the fake SDK factories

from test_gateway_channel_email import make_fake_sdk_modules  # noqa: E402
from test_gateway_channel_telegram import make_fake_aiogram  # noqa: E402
from test_gateway_channel_wecom import make_fake_aiohttp as make_fake_aiohttp_wecom  # noqa: E402


def _make_fake_discord():
    import types

    from test_gateway_channel_discord import FakeClient, FakeFile, FakeIntents

    module = types.ModuleType("discord")
    module.Intents = FakeIntents
    module.Client = FakeClient
    module.File = FakeFile
    return module


def _make_fake_crypto(monkeypatch):
    """Stub the AES modules: build_channel only needs the imports to succeed."""
    import types

    crypto = types.ModuleType("cryptography")
    hazmat = types.ModuleType("cryptography.hazmat")
    primitives = types.ModuleType("cryptography.hazmat.primitives")
    ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
    padding = types.ModuleType("cryptography.hazmat.primitives.padding")
    crypto.hazmat = hazmat
    hazmat.primitives = primitives
    primitives.ciphers = ciphers
    primitives.padding = padding
    ciphers.Cipher = ciphers.algorithms = ciphers.modes = object
    padding.PKCS7 = object
    for name, module in [("cryptography", crypto), ("cryptography.hazmat", hazmat),
                         ("cryptography.hazmat.primitives", primitives),
                         ("cryptography.hazmat.primitives.ciphers", ciphers),
                         ("cryptography.hazmat.primitives.padding", padding)]:
        monkeypatch.setitem(sys.modules, name, module)


MODULES_BY_ID = {
    "telegram": telegram_channel,
    "discord": discord_channel,
    "wecom": wecom,
    "whatsapp": whatsapp_cloud,
    "email": email_channel,
}

CAPS_BY_CHANNEL = {
    "telegram": {"max_text_length": 4000, "len_unit": "utf16", "supports_typing": True,
                 "supports_buttons": True, "supports_reaction": False, "markdown": "none"},
    "discord": {"max_text_length": 2000, "len_unit": "chars", "supports_typing": False,
                "supports_buttons": False, "supports_reaction": False, "markdown": "subset"},
    "wecom": {"max_text_length": 2048, "len_unit": "chars", "supports_typing": False,
              "supports_buttons": False, "supports_reaction": False, "markdown": "none"},
    "whatsapp": {"max_text_length": 4096, "len_unit": "utf16", "supports_typing": False,
                 "supports_buttons": False, "supports_reaction": False, "markdown": "none"},
    "email": {"max_text_length": 60000, "len_unit": "chars", "supports_typing": False,
              "supports_buttons": False, "supports_reaction": False, "markdown": "none"},
}

CONFIG_KEYS_BY_CHANNEL = {
    "telegram": frozenset({"token", "allow_from", "group_allow"}),
    "discord": frozenset({"token", "allow_from", "group_allow"}),
    "wecom": frozenset({"token", "allow_from", "group_allow", "corp_id", "agent_id", "secret",
                        "encoding_aes_key", "callback_host", "callback_port"}),
    "whatsapp": frozenset({"allow_from", "phone_number_id", "access_token", "verify_token",
                           "webhook_host", "webhook_port"}),
    "email": frozenset({"allow_from", "imap_host", "imap_port", "imap_ssl", "smtp_host", "smtp_port",
                        "smtp_starttls", "username", "password", "mailbox", "poll_interval"}),
}


def test_adapter_modules_import_without_sdks_and_declare_constants():
    before = set(sys.modules)
    import gateway.channels  # noqa: F401
    import gateway.channels.discord  # noqa: F401
    import gateway.channels.email_channel  # noqa: F401
    import gateway.channels.telegram  # noqa: F401
    import gateway.channels.wecom  # noqa: F401
    import gateway.channels.whatsapp_cloud  # noqa: F401
    assert not (set(sys.modules) - before) & {"aiogram", "discord", "aiohttp", "cryptography",
                                              "imapclient", "aiosmtplib"}  # lazy: no SDK pulled in
    for channel_id, module in MODULES_BY_ID.items():
        assert isinstance(module.CAPABILITIES, ChannelCapabilities)
        assert module.CONFIG_KEYS == CONFIG_KEYS_BY_CHANNEL[channel_id]
        caps = module.CAPABILITIES
        for name, expected in CAPS_BY_CHANNEL[channel_id].items():
            assert getattr(caps, name) == expected, f"{channel_id}.capabilities.{name}"
    assert set(LOADERS) == {"telegram", "discord", "wecom", "whatsapp", "email"}


def test_adapters_satisfy_channel_protocol(tmp_path):
    instances = {
        "telegram": telegram_channel.TelegramChannel(token="t", uploads_root=tmp_path),
        "discord": discord_channel.DiscordChannel(token="t", uploads_root=tmp_path),
        "wecom": wecom.WeComChannel(corp_id="c", agent_id=1, secret="s", token="t",
                                    encoding_aes_key="x" * 43, uploads_root=tmp_path),
        "whatsapp": whatsapp_cloud.WhatsAppChannel(phone_number_id="p", access_token="a",
                                                   verify_token="v", uploads_root=tmp_path),
        "email": email_channel.EmailChannel(imap_host="i", smtp_host="s", username="u", password="p",
                                            uploads_root=tmp_path),
    }
    for channel_id, channel in instances.items():
        assert channel.id == channel_id
        assert isinstance(channel, Channel)  # runtime_checkable protocol conformance


def test_registry_disables_channel_when_sdk_missing(monkeypatch, tmp_path):
    # None in sys.modules forces ImportError hermetically, SDK install or not.
    monkeypatch.setitem(sys.modules, "aiogram", None)
    monkeypatch.setitem(sys.modules, "discord", None)
    monkeypatch.setitem(sys.modules, "aiohttp", None)
    for module_name in ("cryptography", "cryptography.hazmat.primitives.ciphers",
                        "cryptography.hazmat.primitives.padding"):
        monkeypatch.setitem(sys.modules, module_name, None)
    monkeypatch.setitem(sys.modules, "imapclient", None)
    monkeypatch.setitem(sys.modules, "aiosmtplib", None)
    assert build_channel("telegram", ChannelConfig(id="telegram", token="t"), tmp_path) is None
    assert build_channel("discord", ChannelConfig(id="discord", token="t"), tmp_path) is None
    assert build_channel("wecom", ChannelConfig(id="wecom", token="t",
                                                extra={"corp_id": "c", "agent_id": "1", "secret": "s",
                                                       "encoding_aes_key": "x" * 43}), tmp_path) is None
    assert build_channel("whatsapp", ChannelConfig(id="whatsapp", extra={"phone_number_id": "p",
                                                                        "access_token": "a",
                                                                        "verify_token": "v"}), tmp_path) is None
    assert build_channel("email", ChannelConfig(id="email", extra={"imap_host": "i", "smtp_host": "s",
                                                                   "username": "u", "password": "p"}), tmp_path) is None


def test_registry_disables_channel_without_token(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "aiogram", object())  # SDK present is not enough
    assert build_channel("telegram", ChannelConfig(id="telegram", token=""), tmp_path) is None
    assert build_channel("telegram", ChannelConfig(id="telegram", token="   "), tmp_path) is None


def test_registry_disables_channel_with_missing_required_config(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "aiohttp", object())
    monkeypatch.setitem(sys.modules, "imapclient", object())
    monkeypatch.setitem(sys.modules, "aiosmtplib", object())
    # wecom without corp_id/secret/aes key → ValueError → registry degrades to None
    assert build_channel("wecom", ChannelConfig(id="wecom", token="t"), tmp_path) is None
    assert build_channel("whatsapp", ChannelConfig(id="whatsapp", extra={"phone_number_id": "p"}), tmp_path) is None
    assert build_channel("email", ChannelConfig(id="email", extra={"imap_host": "i"}), tmp_path) is None


def test_registry_unknown_channel_id_is_disabled(tmp_path):
    assert build_channel("slack", ChannelConfig(id="slack", token="x"), tmp_path) is None


def test_registry_builds_channels_via_mocked_sdks(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "aiogram", make_fake_aiogram())
    monkeypatch.setitem(sys.modules, "discord", _make_fake_discord())
    wecom_fake = make_fake_aiohttp_wecom()
    monkeypatch.setitem(sys.modules, "aiohttp", wecom_fake)
    monkeypatch.setitem(sys.modules, "aiohttp.web", wecom_fake.web)
    _make_fake_crypto(monkeypatch)  # build_channel only needs the AES imports to succeed
    imapclient, aiosmtplib = make_fake_sdk_modules()
    monkeypatch.setitem(sys.modules, "imapclient", imapclient)
    monkeypatch.setitem(sys.modules, "aiosmtplib", aiosmtplib)
    uploads = tmp_path / "uploads"
    tg = build_channel("telegram", ChannelConfig(id="telegram", token=" tg-token "), uploads)
    dc = build_channel("discord", ChannelConfig(id="discord", token="dc-token"), uploads)
    wc = build_channel("wecom", ChannelConfig(id="wecom", token="wx-token",
                                              extra={"corp_id": "c", "agent_id": "1", "secret": "s",
                                                     "encoding_aes_key": "x" * 43}), uploads)
    wa = build_channel("whatsapp", ChannelConfig(id="whatsapp", extra={"phone_number_id": "p",
                                                                      "access_token": "a",
                                                                      "verify_token": "v"}), uploads)
    em = build_channel("email", ChannelConfig(id="email", extra={"imap_host": "i", "smtp_host": "s",
                                                                 "username": "u", "password": "p"}), uploads)
    assert isinstance(tg, telegram_channel.TelegramChannel) and tg._token == "tg-token"
    assert isinstance(dc, discord_channel.DiscordChannel) and dc._token == "dc-token"
    assert isinstance(wc, wecom.WeComChannel) and wc._corp_id == "c" and wc._agent_id == 1
    assert isinstance(wa, whatsapp_cloud.WhatsAppChannel) and wa._phone_number_id == "p"
    assert isinstance(em, email_channel.EmailChannel) and em._username == "u"
    assert tg._uploads_root == uploads and em._uploads_root == uploads


def test_email_module_name_does_not_shadow_stdlib_email():
    # the adapter lives in email_channel.py so it never shadows the stdlib email package
    import email as stdlib_email

    assert email_channel.__name__ == "gateway.channels.email_channel"
    assert stdlib_email.__name__ == "email"
