"""Structural conformance for the channel layer (gateway.md §8/§9).

Cheap but load-bearing: both adapter modules import cleanly with aiogram /
discord.py NOT installed (proves the lazy SDK import), declare the capability
and config-key constants the spec pins, and satisfy the Channel protocol.
The registry must degrade a broken channel (missing SDK / missing token /
unknown id) to a one-line log + None instead of taking the gateway down.
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
from gateway.channels import telegram as telegram_channel  # noqa: E402
from gateway.config import ChannelConfig  # noqa: E402

sys.path.insert(0, str(PROJECT_ROOT / "test"))  # reuse the fake SDK factories

from test_gateway_channel_telegram import make_fake_aiogram  # noqa: E402


def _make_fake_discord():
    import types

    from test_gateway_channel_discord import FakeClient, FakeFile, FakeIntents

    module = types.ModuleType("discord")
    module.Intents = FakeIntents
    module.Client = FakeClient
    module.File = FakeFile
    return module


CAPS_BY_CHANNEL = {
    "telegram": {"max_text_length": 4000, "len_unit": "utf16", "supports_typing": True,
                 "supports_buttons": True, "supports_reaction": False, "markdown": "none"},
    "discord": {"max_text_length": 2000, "len_unit": "chars", "supports_typing": False,
                "supports_buttons": False, "supports_reaction": False, "markdown": "subset"},
}


def test_adapter_modules_import_without_sdks_and_declare_constants():
    before = set(sys.modules)
    import gateway.channels  # noqa: F401
    import gateway.channels.discord  # noqa: F401
    import gateway.channels.telegram  # noqa: F401
    assert not (set(sys.modules) - before) & {"aiogram", "discord"}  # lazy: no SDK pulled in
    for module in (telegram_channel, discord_channel):
        assert isinstance(module.CAPABILITIES, ChannelCapabilities)
        assert module.CONFIG_KEYS == frozenset({"token", "allow_from", "group_allow"})
    for channel_id, spec_caps in CAPS_BY_CHANNEL.items():
        module = telegram_channel if channel_id == "telegram" else discord_channel
        caps = module.CAPABILITIES
        for name, expected in spec_caps.items():
            assert getattr(caps, name) == expected, f"{channel_id}.capabilities.{name}"
    assert set(LOADERS) == {"telegram", "discord"}


def test_adapters_satisfy_channel_protocol(tmp_path):
    for module in (telegram_channel, discord_channel):
        channel = module.TelegramChannel(token="t", uploads_root=tmp_path) if module is telegram_channel \
            else module.DiscordChannel(token="t", uploads_root=tmp_path)
        assert channel.id == ("telegram" if module is telegram_channel else "discord")
        assert isinstance(channel, Channel)  # runtime_checkable protocol conformance


def test_registry_disables_channel_when_sdk_missing(monkeypatch, tmp_path):
    # None in sys.modules forces ImportError hermetically, SDK install or not.
    monkeypatch.setitem(sys.modules, "aiogram", None)
    monkeypatch.setitem(sys.modules, "discord", None)
    assert build_channel("telegram", ChannelConfig(id="telegram", token="t"), tmp_path) is None
    assert build_channel("discord", ChannelConfig(id="discord", token="t"), tmp_path) is None


def test_registry_disables_channel_without_token(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "aiogram", object())  # SDK present is not enough
    assert build_channel("telegram", ChannelConfig(id="telegram", token=""), tmp_path) is None
    assert build_channel("telegram", ChannelConfig(id="telegram", token="   "), tmp_path) is None


def test_registry_unknown_channel_id_is_disabled(tmp_path):
    assert build_channel("slack", ChannelConfig(id="slack", token="x"), tmp_path) is None


def test_registry_builds_channels_via_mocked_sdks(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "aiogram", make_fake_aiogram())
    monkeypatch.setitem(sys.modules, "discord", _make_fake_discord())
    uploads = tmp_path / "uploads"
    tg = build_channel("telegram", ChannelConfig(id="telegram", token=" tg-token "), uploads)
    dc = build_channel("discord", ChannelConfig(id="discord", token="dc-token"), uploads)
    assert isinstance(tg, telegram_channel.TelegramChannel) and tg._token == "tg-token"
    assert isinstance(dc, discord_channel.DiscordChannel) and dc._token == "dc-token"
    assert tg._uploads_root == uploads and dc._uploads_root == uploads
