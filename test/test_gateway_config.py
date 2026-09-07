import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway.config import (
    ConfigError,
    GatewayConfig,
    build_config,
    load_config,
    parse_yaml,
    resolve_config_path,
)

ABS_WORKSPACE = str(Path(os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))).resolve() / "gateway-ws")


def _write(tmp_path, text: str) -> Path:
    path = tmp_path / "gateway.yaml"
    path.write_text(text, encoding="utf-8")
    return path


VALID = f"""
worker: ws://127.0.0.1:8765  # inline comment
workspace: {ABS_WORKSPACE}
worker_token: secret-token
channels:
  telegram:
    token: '${{TG_TOKEN}}'
    allow_from: ["111", "222"]  # list comment
    group_allow: []
  discord:
    token: "abc#not-a-comment"
pairing:
  enabled: false
  ttl_minutes: 30
cooldown_per_minute: 7
uploads_dir: uploads
"""


def test_valid_config_parses_every_section(tmp_path, monkeypatch):
    monkeypatch.setenv("TG_TOKEN", "tg-secret")
    config = load_config(_write(tmp_path, VALID), env=dict(os.environ))
    assert isinstance(config, GatewayConfig)
    assert config.worker == "ws://127.0.0.1:8765"
    assert config.workspace == ABS_WORKSPACE
    assert config.worker_token == "secret-token"
    assert config.channels["telegram"].token == "tg-secret"
    assert config.channels["telegram"].allow_from == ("111", "222")
    assert config.channels["telegram"].group_allow == ()
    assert config.channels["discord"].token == "abc#not-a-comment"
    assert config.pairing.enabled is False
    assert config.pairing.ttl_minutes == 30
    assert config.cooldown_per_minute == 7
    assert config.uploads_dir == "uploads"


def test_defaults_applied_for_optional_keys(tmp_path):
    config = load_config(_write(tmp_path, f"worker: stdio\nworkspace: {ABS_WORKSPACE}\n"), env={})
    assert config.worker == "stdio"
    assert config.worker_token is None
    assert config.channels == {}
    assert config.pairing.enabled is True
    assert config.pairing.ttl_minutes == 60
    assert config.cooldown_per_minute == 10
    assert config.uploads_dir == "uploads"


def test_unknown_top_level_key_is_an_error(tmp_path):
    with pytest.raises(ConfigError, match="unknown key: oops"):
        build_config({"worker": "stdio", "workspace": ABS_WORKSPACE, "oops": 1})


def test_unknown_pairing_key_is_an_error():
    with pytest.raises(ConfigError, match="pairing.bad"):
        build_config({"worker": "stdio", "workspace": ABS_WORKSPACE, "pairing": {"bad": True}})


def test_unknown_channel_key_is_an_error():
    with pytest.raises(ConfigError, match="channels.telegram.bad"):
        build_config(
            {"worker": "stdio", "workspace": ABS_WORKSPACE, "channels": {"telegram": {"bad": 1}}}
        )


# --- per-channel key schemas (WP11: wecom / whatsapp / email) -----------------------


def test_wecom_whatsapp_email_keys_parse_with_types():
    config = build_config({"worker": "stdio", "workspace": ABS_WORKSPACE, "channels": {
        "wecom": {"token": "cb-token", "corp_id": "corp-1", "agent_id": 1000002, "secret": "s",
                  "encoding_aes_key": "x" * 43, "callback_host": "127.0.0.1", "callback_port": 8081},
        "whatsapp": {"phone_number_id": 106540352242922, "access_token": "a", "verify_token": "v",
                     "webhook_port": 9090},
        "email": {"imap_host": "i", "smtp_host": "s", "username": "u", "password": "p",
                  "imap_ssl": False, "smtp_starttls": True, "mailbox": "Archive", "poll_interval": 60},
    }})
    wecom = config.channels["wecom"]
    assert wecom.token == "cb-token" and wecom.extra["agent_id"] == "1000002"  # numeric scalar → str
    assert wecom.extra["callback_port"] == 8081 and wecom.extra["encoding_aes_key"] == "x" * 43
    whatsapp = config.channels["whatsapp"]
    assert whatsapp.extra["phone_number_id"] == "106540352242922" and whatsapp.extra["webhook_port"] == 9090
    email = config.channels["email"]
    assert email.extra["imap_ssl"] is False and email.extra["smtp_starttls"] is True
    assert email.extra["mailbox"] == "Archive" and email.extra["poll_interval"] == 60


def test_unknown_per_channel_key_is_an_error():
    data = {"worker": "stdio", "workspace": ABS_WORKSPACE,
            "channels": {"wecom": {"corp_id": "c", "oops": 1}}}
    with pytest.raises(ConfigError, match="channels.wecom.oops"):
        build_config(data)
    # keys of one channel are not valid for another; unknown ids get no extra keys
    data["channels"] = {"email": {"corp_id": "c"}}
    with pytest.raises(ConfigError, match="channels.email.corp_id"):
        build_config(data)
    data["channels"] = {"slack": {"corp_id": "c"}}
    with pytest.raises(ConfigError, match="channels.slack.corp_id"):
        build_config(data)


def test_per_channel_value_types_are_validated():
    base = {"worker": "stdio", "workspace": ABS_WORKSPACE}
    with pytest.raises(ConfigError, match="channels.whatsapp.webhook_port"):
        build_config({**base, "channels": {"whatsapp": {"webhook_port": "8080"}}})
    with pytest.raises(ConfigError, match="channels.whatsapp.webhook_port"):
        build_config({**base, "channels": {"whatsapp": {"webhook_port": 70000}}})
    with pytest.raises(ConfigError, match="channels.email.imap_ssl"):
        build_config({**base, "channels": {"email": {"imap_ssl": "true"}}})
    with pytest.raises(ConfigError, match="channels.email.poll_interval"):
        build_config({**base, "channels": {"email": {"poll_interval": 4}}})
    with pytest.raises(ConfigError, match="channels.email.username"):
        build_config({**base, "channels": {"email": {"username": ""}}})
    with pytest.raises(ConfigError, match="channels.wecom.agent_id"):
        build_config({**base, "channels": {"wecom": {"agent_id": True}}})


def test_undefined_env_variable_is_an_error(tmp_path):
    with pytest.raises(ConfigError, match="UNDEFINED_VAR"):
        load_config(_write(tmp_path, "worker: stdio\nworkspace: ${UNDEFINED_VAR}\n"), env={})


def test_missing_required_worker_is_an_error():
    with pytest.raises(ConfigError, match="missing required key: worker"):
        build_config({"workspace": ABS_WORKSPACE})


def test_missing_required_workspace_is_an_error():
    with pytest.raises(ConfigError, match="missing required key: workspace"):
        build_config({"worker": "stdio"})


def test_worker_must_be_stdio_or_ws_url():
    with pytest.raises(ConfigError, match="worker must be"):
        build_config({"worker": "http://127.0.0.1:8765", "workspace": ABS_WORKSPACE})


def test_workspace_must_be_absolute():
    with pytest.raises(ConfigError, match="workspace must be an absolute path"):
        build_config({"worker": "stdio", "workspace": "relative/path"})


def test_numeric_ranges_are_validated():
    base = {"worker": "stdio", "workspace": ABS_WORKSPACE}
    with pytest.raises(ConfigError, match="cooldown_per_minute"):
        build_config({**base, "cooldown_per_minute": 0})
    with pytest.raises(ConfigError, match="ttl_minutes"):
        build_config({**base, "pairing": {"ttl_minutes": 0}})
    with pytest.raises(ConfigError, match="ttl_minutes"):
        build_config({**base, "pairing": {"ttl_minutes": "60"}})


def test_inline_list_and_scalar_parsing():
    data = parse_yaml('a: ["x", \'y\', z]\nempty: []\nflag: true\ncount: 3\nplain: bare-value\n', env={})
    assert data == {"a": ("x", "y", "z"), "empty": (), "flag": True, "count": 3, "plain": "bare-value"}


def test_comments_and_quote_styles():
    text = "# leading comment\nkey: 'value # kept'\nother: \"double # kept\"\nlast: v # trailing\n"
    assert parse_yaml(text, env={}) == {
        "key": "value # kept",
        "other": "double # kept",
        "last": "v",
    }


def test_tab_indentation_is_an_error():
    with pytest.raises(ConfigError, match="tab indentation"):
        parse_yaml("a:\n\tb: 1\n", env={})


def test_resolve_config_path_prefers_explicit_then_workspace_default(tmp_path):
    explicit = _write(tmp_path, VALID)
    assert resolve_config_path(str(explicit), tmp_path) == explicit
    rind_dir = tmp_path / ".rind"
    default = rind_dir / "gateway.yaml"
    rind_dir.mkdir()
    default.write_text(VALID, encoding="utf-8")
    assert resolve_config_path(None, tmp_path) == default
    with pytest.raises(ConfigError, match="not found"):
        resolve_config_path(None, tmp_path / "elsewhere")
    with pytest.raises(ConfigError, match="not found"):
        resolve_config_path(str(tmp_path / "missing.yaml"), tmp_path)
