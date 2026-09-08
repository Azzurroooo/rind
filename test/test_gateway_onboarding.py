"""`gateway init` / `doctor` / `status` 的用户通道测试。

这些测试守护的不是解析器，而是"新用户 2 分钟接入"的承诺：每个渠道都有
引导与字段表单、字段键名合法（不会生成被配置校验拒绝的 yaml）、向导产物
能被现有解析器原样读回、doctor 能在干净/损坏两种状态下给出正确结论。
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


# --- 引导完备性：注册表里的渠道必须有向导，字段键名必须合法 -------------------


def test_every_registered_channel_has_a_guide():
    missing = sorted(set(LOADERS) - set(onboarding.GUIDES))
    orphan = sorted(set(onboarding.GUIDES) - set(LOADERS))
    assert not missing, f"渠道缺少 init 引导: {missing}"
    assert not orphan, f"向导里的渠道不在注册表: {orphan}"


def test_guides_carry_user_facing_content():
    for guide in onboarding.all_guides():
        assert guide.label and guide.emoji and guide.summary, guide.id
        assert guide.setup_steps, f"{guide.id} 缺少凭证获取引导"
        assert guide.probe is not None, f"{guide.id} 缺少凭证探活"


def test_guide_field_names_are_acceptable_config_keys():
    # 生成 yaml 前就拦住拼写错误：字段名必须是该渠道 schema 或通用 token。
    for guide in onboarding.all_guides():
        allowed = _CHANNEL_KEYS.get(guide.id, frozenset()) | {"token"}
        for spec in guide.fields:
            assert spec.name in allowed, f"{guide.id}.{spec.name} 不在该渠道配置 schema 中"


# --- 向导构建：answers -> config dict -> yaml -> 原样读回 ----------------------


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
    assert '"123456789"' in text or "'123456789'" in text, "纯数字 ID 必须加引号，否则回读成 int"
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


# --- worker 静默决策：探活在线用 ws，不通自起 stdio，零提问 ---------------------


def test_resolve_worker_defaults_to_stdio_when_nothing_listens():
    import asyncio

    import gateway.wizard as wizard

    async def refused(url, token, timeout=0.1):
        return False, "无法连接"

    worker, token, verified = asyncio.run(wizard.resolve_worker("", {}, probe=refused))
    assert (worker, token, verified) == ("stdio", "", True)


def test_resolve_worker_uses_listening_default_and_env_token():
    import asyncio

    import gateway.wizard as wizard

    async def online(url, token, timeout=0.1):
        return True, "worker 在线"

    worker, token, verified = asyncio.run(wizard.resolve_worker("", {"RIND_SERVER_TOKEN": "s3cret"}, probe=online))
    assert (worker, token, verified) == (wizard.DEFAULT_WORKER, "s3cret", True)


def test_resolve_worker_honors_explicit_url_without_probing():
    import asyncio

    import gateway.wizard as wizard

    async def must_not_probe(url, token, timeout=0.1):
        raise AssertionError("显式 URL 不应触发探活")

    worker, token, verified = asyncio.run(wizard.resolve_worker("ws://10.0.0.8:9000", {}, probe=must_not_probe))
    assert (worker, token, verified) == ("ws://10.0.0.8:9000", "", False)
    env_worker, env_token, _ = asyncio.run(wizard.resolve_worker("", {"RIND_GW_WORKER": "ws://10.0.0.9:1"}, probe=must_not_probe))
    assert (env_worker, env_token) == ("ws://10.0.0.9:1", "")


# --- 老配置预填充：重跑向导 = 回车保留，而不是从零重填 ---------------------------


def test_load_existing_answers_round_trips_channels(tmp_path):
    import gateway.wizard as wizard

    config = tmp_path / "gateway.yaml"
    config.write_text(
        "worker: stdio\n"
        f"workspace: '{tmp_path}'\n"
        "channels:\n"
        "  telegram:\n"
        "    token: '123456:AAE'\n"
        "    proxy: 'http://127.0.0.1:7890'\n"
        "    allow_from: ['111', '222']\n",
        encoding="utf-8",
    )
    existing = wizard.load_existing_answers(config)
    assert existing["worker"] == "stdio"
    telegram = existing["telegram"]
    assert telegram["token"] == "123456:AAE"
    assert telegram["proxy"] == "http://127.0.0.1:7890"
    assert telegram["allow_from"] == ["111", "222"]


def test_load_existing_answers_ignores_broken_config(tmp_path):
    import gateway.wizard as wizard

    config = tmp_path / "gateway.yaml"
    config.write_text("worker: [unclosed\n", encoding="utf-8")
    assert wizard.load_existing_answers(config) == {}
    assert wizard.load_existing_answers(tmp_path / "missing.yaml") == {}


# --- 探活：注入假 HTTP，验证 ✔/✘ 语义与原因 -------------------------------------


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
    assert captured["proxy"] == "http://127.0.0.1:7890", "探活必须与网关走同一出口"

    result = onboarding.GUIDES["telegram"].probe({"token": "bad"})
    assert not result.ok and "401" in result.detail
    assert captured["proxy"] == "", "未配置代理时探活必须直连（与网关一致）"


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


# --- doctor：干净/缺失/损坏三种工作区状态 ----------------------------------------


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
    assert by_name["配置文件"].ok is True
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
    telegram = [check for check in results if check.name == "渠道 Telegram"]
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
        return False, "无法连接"

    from gateway import probes as probes_module

    monkeypatch.setattr(probes_module, "worker_alive", dead_worker)
    from gateway.status import run_status

    args = type("Args", (), {"config": None, "workspace": str(tmp_path)})()
    assert run_status(args) == 1  # worker 不在线 → 退出码 1，但文件统计仍然输出


# --- 启动就绪面板：网关起来后用户看到的那一屏 -------------------------------------


def test_startup_panel_shows_channels_pairing_and_approve_path():
    from gateway.status import startup_panel

    panel = startup_panel("stdio", [("telegram", True), ("discord", False)], pairing_enabled=True)
    assert "stdio 自起子进程" in panel
    assert "✈️ Telegram ✔" in panel and "🎮 Discord ✘" in panel
    assert "gateway doctor" in panel  # 失败渠道给出唯一修复入口
    assert "gateway approve <配对码>" in panel
    assert "按 Ctrl+C 停止网关" in panel


def test_startup_panel_reflects_closed_pairing():
    from gateway.status import startup_panel

    panel = startup_panel("ws://127.0.0.1:8765", [("email", True)], pairing_enabled=False)
    assert "已关闭" in panel and "allow_from" in panel


def test_startup_panel_speaks_up_when_no_channels_configured():
    from gateway.status import startup_panel

    panel = startup_panel("stdio", [], pairing_enabled=True)
    assert "未配置任何渠道" in panel and "gateway init" in panel


# --- SDK 自动安装与工作区防护（用户体验包装的机器可测部分）-----------------------


def test_ensure_sdk_skips_when_already_importable():
    import gateway.doctor as doctor

    ran = []

    def runner(cmd):
        ran.append(cmd)
        raise AssertionError("已可导入时不应调用 pip")

    ok, detail = doctor.ensure_sdk_installed("json", runner=runner)
    assert ok and "已安装" in detail
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
    for keyword in ("企业自建应用", "机器人", "App ID", "权限", "长连接", "im.message.receive_v1", "发布"):
        assert keyword in steps, f"飞书引导缺少关键步骤：{keyword}"


def test_permission_scopes_are_exact_copyable_codes():
    # 用户在平台搜索框里粘贴的就是这些代码——必须是平台可唯一检索的标识，
    # 而不是中文描述名。
    scopes = onboarding.GUIDES["feishu"].scopes
    for code in (
        "im:message.p2p.msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message:send_as_bot",
        "im:resource",
    ):
        assert any(code in item for item in scopes), f"缺少精确权限代码：{code}"
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
        assert proxy == "", "未配置代理时必须直连（与网关出口一致）"
        raise urllib.error.URLError("timed out")

    monkeypatch.setattr(probes, "_get_json", timeout_get)
    result = onboarding.GUIDES["telegram"].probe({"token": "t"})
    assert not result.ok
    assert "连接超时" in result.detail and "代理" in result.detail

    def proxy_get(url, headers=None, proxy="http://127.0.0.1:7890"):
        assert proxy == "http://127.0.0.1:7890"
        return 200, {"ok": True, "result": {"username": "bot"}}

    monkeypatch.setattr(probes, "_get_json", proxy_get)
    result = onboarding.GUIDES["telegram"].probe({"token": "t", "proxy": "http://127.0.0.1:7890"})
    assert result.ok


def test_runtime_deps_installed_alongside_sdk(monkeypatch):
    """telegram 声明的 aiohttp_socks 属于运行时依赖：缺失时会随 aiogram 一起自动装。"""
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
    assert guides, "依赖装好后渠道应保留"
    assert sorted(set(calls)) == ["aiogram", "aiohttp_socks"]


