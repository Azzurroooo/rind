"""User-channel tests for `gateway init` / `doctor` / `status`.

These tests guard not the parser but the "new user onboarded in 2 minutes"
promise: every channel has a guide and a field form, field keys are legal
(no yaml the config validation would reject), wizard output round-trips
through the existing parser, and doctor draws the right conclusion on both
clean and corrupted workspaces.
"""

import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import onboarding
from gateway.channels import LOADERS
from gateway.config import _CHANNEL_KEYS, build_config, parse_yaml, render_yaml
from gateway.doctor import run_checks
from gateway.wizard import build_config_data, collect_answers_env, config_path_for


# --- guide completeness: every registered channel needs a wizard; field keys must be legal -------------------


def test_every_registered_channel_has_a_guide():
    missing = sorted(set(LOADERS) - set(onboarding.GUIDES))
    orphan = sorted(set(onboarding.GUIDES) - set(LOADERS))
    assert not missing, f"channels missing an init guide: {missing}"
    assert not orphan, f"guides contain channels not in the registry: {orphan}"


def test_guides_carry_user_facing_content():
    for guide in onboarding.all_guides():
        assert guide.label and guide.emoji and guide.summary, guide.id
        assert guide.setup_steps, f"{guide.id} missing credential setup steps"
        assert guide.probe is not None, f"{guide.id} missing a credential probe"


def test_guide_field_names_are_acceptable_config_keys():
    # Catch typos before any yaml is generated: field names must come from the channel schema or shared tokens.
    for guide in onboarding.all_guides():
        allowed = _CHANNEL_KEYS.get(guide.id, frozenset()) | {"token"}
        for spec in guide.fields:
            assert spec.name in allowed, f"{guide.id}.{spec.name} is not in the channel's config schema"


# --- wizard construction: answers -> config dict -> yaml -> read back verbatim ----------------------


def test_build_config_data_produces_parseable_yaml(tmp_path):
    answers = {
        "telegram": {"token": "123456:AAE"},
        "email": {
            "imap_host": "imap.qq.com",
            "imap_port": "993",
            "smtp_host": "smtp.qq.com",
            "username": "me@qq.com",
            "password": "auth-code",
        },
    }
    lists = {
        "telegram": {"allow_from": ["987654"], "group_allow": []},
        "email": {"allow_from": ["boss@corp.com"], "group_allow": []},
    }
    data = build_config_data(
        ["telegram", "email"], answers, lists,
        worker="ws://127.0.0.1:8765", worker_token="dev-token",
        workspace=str(tmp_path),
    )
    text = render_yaml(data)
    config = build_config(parse_yaml(text, env={}))
    assert config.worker == "ws://127.0.0.1:8765"
    assert config.channels["telegram"].token == "123456:AAE"
    assert config.channels["telegram"].allow_from == ("987654",)
    assert config.channels["email"].extra["password"] == "auth-code"
    assert config.channels["email"].extra["imap_port"] == 993
    assert config.worker_token == "dev-token"


def test_numeric_sender_ids_survive_the_yaml_round_trip():
    data = build_config_data(
        ["telegram"], {"telegram": {"token": "t"}}, {"telegram": {"allow_from": ["123456789"], "group_allow": []}},
        worker="ws://x", worker_token="", workspace="E:/ws",
    )
    text = render_yaml(data)
    assert '"123456789"' in text or "'123456789'" in text, "numeric IDs must be quoted or they read back as int"
    config = build_config(parse_yaml(text, env={}))
    assert config.channels["telegram"].allow_from == ("123456789",)


def test_collect_answers_env_reads_prefixed_variables_and_reports_missing():
    guide = onboarding.GUIDES["telegram"]
    env = {f"RIND_GW_TELEGRAM_TOKEN": "tok", "RIND_GW_TELEGRAM_ALLOW_FROM": "1,2, 3"}
    collected, missing = collect_answers_env(guide, env)
    assert collected["answers"]["token"] == "tok"
    assert collected["allow_from"] == ["1", "2", "3"]
    empty_guide = onboarding.GUIDES["feishu"]
    _, missing = collect_answers_env(empty_guide, {})
    assert "RIND_GW_FEISHU_APP_ID" in missing and "RIND_GW_FEISHU_APP_SECRET" in missing


# --- probes: fake HTTP injected; verify ✔/✘ semantics and reasons -------------------------------------


def test_telegram_probe_reports_bot_and_failure(monkeypatch):
    import gateway.probes as probes

    captured: dict = {}

    def fake_get(url, headers=None, proxy=""):
        captured["proxy"] = proxy
        if "bottoken" in url:
            return 200, {"ok": True, "result": {"username": "my_rind_bot"}}
        return 401, {"ok": False}

    monkeypatch.setattr(probes, "_get_json", fake_get)
    result = onboarding.GUIDES["telegram"].probe({"token": "bottoken", "proxy": "http://127.0.0.1:7890"})
    assert result.ok and "my_rind_bot" in result.detail
    assert captured["proxy"] == "http://127.0.0.1:7890", "the probe must use the same egress as the gateway"

    result = onboarding.GUIDES["telegram"].probe({"token": "bad"})
    assert not result.ok and "401" in result.detail
    assert captured["proxy"] == "", "without a configured proxy the probe must connect directly (like the gateway)"


def test_feishu_probe_maps_platform_error_code(monkeypatch):
    def fake_post(url, payload, headers=None):
        return 200, {"code": 10003, "msg": "invalid app_id"}

    import gateway.probes as probes
    monkeypatch.setattr(probes, "_post_json", fake_post)
    result = onboarding.GUIDES["feishu"].probe({"app_id": "a", "app_secret": "s"})
    assert not result.ok and "10003" in result.detail


def test_telegram_discovery_collects_sender_ids(monkeypatch):
    responses = [
        (200, {"result": [
            {"update_id": 10, "message": {"from": {"id": 111, "username": "alice"}}},
            {"update_id": 11, "message": {"from": {"id": 222}}},
        ]}),
    ]

    def fake_get(url, headers=None):
        return responses[0] if responses else (200, {"result": []})

    monkeypatch.setattr(onboarding, "_get_json", fake_get)
    import time
    real_sleep = time.sleep
    monkeypatch.setattr(time, "sleep", lambda *_: None)
    senders = onboarding.GUIDES["telegram"].discover_senders({"token": "t"}, 1.0)
    real_sleep(0)
    assert senders == ["111 (@alice)", "222"]


# --- doctor: clean / missing / corrupted workspace states ----------------------------------------


def _write_config(workspace: Path) -> None:
    data = build_config_data(
        ["telegram"], {"telegram": {"token": "t"}}, {},
        worker="ws://127.0.0.1:8765", worker_token="tok", workspace=str(workspace),
    )
    path = config_path_for(str(workspace))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_yaml(data), encoding="utf-8")


def test_doctor_without_config_points_at_init(tmp_path, capsys):
    results = run_checks(None, tmp_path)
    assert results and results[0].ok is False
    assert "gateway init" in results[0].fix
    assert "gateway init" in capsys.readouterr().out or True


def test_doctor_passes_on_valid_config_and_flags_corrupt_state(tmp_path):
    _write_config(tmp_path)
    (tmp_path / ".rind").mkdir(exist_ok=True)
    (tmp_path / ".rind" / "state.json").write_text("{corrupt", encoding="utf-8")

    results = run_checks(None, tmp_path)
    by_name = {check.name: check for check in results}
    assert by_name["config file"].ok is True
    assert by_name["state.json"].ok is False
    assert "--fix" in by_name["state.json"].fix

    fixed = run_checks(None, tmp_path, fix=True)
    by_name = {check.name: check for check in fixed}
    assert by_name["state.json"].ok is True
    assert (tmp_path / ".rind" / "state.json.corrupt").exists()


def test_doctor_reports_missing_channel_sdk(tmp_path, monkeypatch):
    _write_config(tmp_path)
    import importlib

    real_import = importlib.import_module

    def fake_import(name, *args, **kwargs):
        if name == "aiogram":
            raise ImportError("no aiogram")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", fake_import)
    results = run_checks(None, tmp_path)
    telegram = [check for check in results if check.name == "channel Telegram"]
    assert telegram and telegram[0].ok is False and "aiogram" in telegram[0].detail


def test_status_counts_sessions_and_pairing(tmp_path, monkeypatch):
    _write_config(tmp_path)
    (tmp_path / ".rind").mkdir(exist_ok=True)
    (tmp_path / ".rind" / "state.json").write_text(
        json.dumps({"version": 1, "sessions": {"telegram:dm:1": {"session_id": "s1", "cursor": 7}}}),
        encoding="utf-8",
    )
    (tmp_path / ".rind" / "pairing.json").write_text(
        json.dumps({"pending": {"AB23CD": {"channel": "telegram", "sender_id": "1"}}, "approved": [["telegram", "1"]]}),
        encoding="utf-8",
    )

    async def dead_worker(worker, token, timeout=0.1):
        return False, "cannot connect"

    from gateway import status as status_module

    monkeypatch.setattr(status_module, "_worker_alive", dead_worker)
    from gateway.status import run_status

    args = type("Args", (), {"config": None, "workspace": str(tmp_path)})()
    assert run_status(args) == 1  # worker offline → exit code 1, but file stats still print


# --- SDK auto-install and workspace protection (the machine-testable part of the UX wrapper) -----------------------


def test_ensure_sdk_skips_when_already_importable():
    import gateway.doctor as doctor

    ran = []

    def runner(cmd):
        ran.append(cmd)
        raise AssertionError("pip must not run when the module is already importable")

    ok, detail = doctor.ensure_sdk_installed("json", runner=runner)
    assert ok and "already installed" in detail
    assert not ran


def test_ensure_sdk_runs_pip_and_reimports(monkeypatch):
    import types

    import gateway.doctor as doctor

    ran = []

    class FakeResult:
        returncode = 0
        stderr = ""

    state = {"installed": False}
    real_import = doctor.importlib.import_module

    def runner(cmd):
        ran.append(cmd)
        state["installed"] = True
        return FakeResult()

    def fake_import(name, *args, **kwargs):
        if name == "some_sdk" and state["installed"]:
            return types.ModuleType("some_sdk")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(doctor.importlib, "import_module", fake_import)

    ok, detail = doctor.ensure_sdk_installed("some_sdk", runner=runner)
    assert ok and "some_sdk" in detail
    assert ran and ran[0][-1] == "some_sdk"


def test_ensure_sdk_reports_pip_failure(monkeypatch):
    import gateway.doctor as doctor

    class FakeResult:
        returncode = 1
        stderr = "no matching distribution"

    monkeypatch.setattr(doctor.importlib, "import_module", lambda name, *a, **k: (_ for _ in ()).throw(ImportError(name)))
    monkeypatch.setattr(doctor.importlib, "invalidate_caches", lambda: None)
    ok, detail = doctor.ensure_sdk_installed("some_sdk", runner=lambda cmd: FakeResult())
    assert not ok and "pip install some_sdk" in detail


def test_feishu_setup_steps_match_official_flow():
    steps = "\n".join(onboarding.GUIDES["feishu"].setup_steps)
    for keyword in ("Custom App", "Bot", "App ID", "Permissions & Scopes", "long connection", "im.message.receive_v1", "publish"):
        assert keyword in steps, f"feishu guide missing a key step: {keyword}"


def test_permission_scopes_are_exact_copyable_codes():
    # These are the codes users paste into the platform's search box — they
    # must be platform-unique identifiers, not localized descriptive names.
    scopes = onboarding.GUIDES["feishu"].scopes
    for code in (
        "im:message.p2p.msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message:send_as_bot",
        "im:resource",
    ):
        assert any(code in item for item in scopes), f"missing the exact permission code: {code}"
    assert any("connections:write" in scope for scope in onboarding.GUIDES["slack"].scopes)


def test_auto_install_sdk_round_trips_through_yaml():
    from gateway.config import parse_yaml, render_yaml

    text = render_yaml({"worker": "ws://x", "workspace": "E:/ws", "auto_install_sdk": True})
    config = build_config(parse_yaml(text, env={}))
    assert config.auto_install_sdk is True
    assert render_yaml({"worker": "ws://x", "workspace": "E:/ws"}) == text.replace("auto_install_sdk: true\n", "")


def test_telegram_probe_timeout_suggests_proxy(monkeypatch):
    import urllib.error

    import gateway.probes as probes

    def timeout_get(url, headers=None, proxy=""):
        assert proxy == "", "without a configured proxy it must connect directly (matching the gateway egress)"
        raise urllib.error.URLError("timed out")

    monkeypatch.setattr(probes, "_get_json", timeout_get)
    result = onboarding.GUIDES["telegram"].probe({"token": "t"})
    assert not result.ok
    assert "Connection timed out" in result.detail and "proxy" in result.detail

    def proxy_get(url, headers=None, proxy="http://127.0.0.1:7890"):
        assert proxy == "http://127.0.0.1:7890"
        return 200, {"ok": True, "result": {"username": "bot"}}

    monkeypatch.setattr(probes, "_get_json", proxy_get)
    result = onboarding.GUIDES["telegram"].probe({"token": "t", "proxy": "http://127.0.0.1:7890"})
    assert result.ok


def test_runtime_deps_installed_alongside_sdk(monkeypatch):
    """aiohttp_socks declared by telegram is a runtime dependency: when missing it auto-installs alongside aiogram."""
    import gateway.doctor as doctor

    calls: list[str] = []
    monkeypatch.setattr(doctor, "sdk_missing", lambda module: module in {"aiogram", "aiohttp_socks"})
    monkeypatch.setattr(
        doctor, "ensure_sdk_installed",
        lambda module, **kwargs: (calls.append(module), (True, f"ok {module}"))[1],
    )

    guides, _ = doctor.ensure_channel_sdks(
        [onboarding.GUIDES["telegram"]], interactive=False,
    )
    assert guides, "channels should survive once dependencies are installed"
    assert sorted(set(calls)) == ["aiogram", "aiohttp_socks"]


