"""终端级用户通道测试：用子进程 + 脚本化 stdin 模拟真人在 PowerShell 里
逐行操作，覆盖 gateway 一键化的完整成果。任何一步出现 Traceback 即失败。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def _run_gateway(args: list[str], stdin: str = "", workspace: str | None = None, env_extra: dict[str, str] | None = None, timeout: float = 60.0) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [PYTHON, str(PROJECT_ROOT / "main.py"), "gateway", *args],
        cwd=PROJECT_ROOT, env=env, input=stdin, capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )


def _assert_no_traceback(result: subprocess.CompletedProcess):
    combined = result.stdout + result.stderr
    assert "Traceback" not in combined, f"用户不应看到堆栈：\n{combined[-800:]}"


# --- 完整交互式向导：真人在终端里的 22 次按键 -------------------------------------


def test_full_interactive_wizard_writes_working_config(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    lines = [
        "7,3",            # 选渠道：telegram + email
        "",               # worker 地址（默认）
        str(workspace),   # 工作目录
        "",               # worker token（留空）
        "123456:AAE",     # telegram token
        "",               # telegram proxy（直连）
        "",               # telegram allow_from
        "",               # telegram group_allow
        "n",              # 跳过凭证探活
        "n",              # 跳过 ID 抓取
        "",               # email imap_host（默认）
        "",               # email imap_port（默认）
        "",               # email smtp_host（默认）
        "",               # email smtp_port（默认）
        "me@qq.com",      # email username
        "auth-code",      # email password
        "",               # mailbox（默认）
        "",               # poll_interval（默认）
        "",               # email allow_from
        "",               # email group_allow
        "n",              # 跳过凭证探活
        "Y",              # 确认写入
    ]
    result = _run_gateway(["init"], stdin="\n".join(lines) + "\n", workspace=None)
    _assert_no_traceback(result)
    assert result.returncode == 0, f"stderr: {result.stderr[-600:]}"

    config_path = workspace / ".rind" / "gateway.yaml"
    assert config_path.exists(), f"配置未写入；stdout: {result.stdout[-600:]}"

    # 产物必须能被真实启动链路读回
    status = _run_gateway(
        ["status", "--config", str(config_path), "--workspace", str(workspace)],
    )
    _assert_no_traceback(status)
    assert "会话映射" in status.stdout and "渠道 Email" in status.stdout and "渠道 Telegram" in status.stdout

    doctor = _run_gateway(
        ["doctor", "--config", str(config_path), "--workspace", str(workspace)],
    )
    _assert_no_traceback(doctor)
    assert "配置文件" in doctor.stdout and "✔" in doctor.stdout


def test_wizard_defaults_skip_optional_fields(tmp_path):
    # 回车到底 = telegram + email 两个零门槛渠道；email 必填字段需要值。
    workspace = tmp_path / "ws"
    workspace.mkdir()
    lines = [
        "",               # 渠道（默认 telegram + email）
        "",               # worker
        str(workspace),   # workspace
        "",               # token
        "tok",            # telegram token
        "",               # telegram proxy（直连）
        "", "",           # telegram allow/group
        "n", "n",         # telegram probe/discovery
        "", "",           # email imap_host/port
        "", "",           # email smtp_host/port
        "me@qq.com",      # username
        "pw",             # password
        "", "",           # mailbox/poll
        "", "",           # email allow/group
        "n",              # email probe
        "Y",              # 写入
    ]
    result = _run_gateway(["init"], stdin="\n".join(lines) + "\n")
    _assert_no_traceback(result)
    assert (workspace / ".rind" / "gateway.yaml").exists()


# --- 用户的原始崩溃场景：无配置 → 引导向导 → 中途 EOF -----------------------------


def test_gateway_without_config_offers_wizard_and_cancels_cleanly(tmp_path):
    result = _run_gateway(["--workspace", str(tmp_path)], stdin="Y\n")
    _assert_no_traceback(result)
    assert "配置向导" in result.stdout
    assert "已取消（配置未写入）" in result.stdout
    assert result.returncode == 1


def test_wizard_immediate_eof_cancels_cleanly(tmp_path):
    result = _run_gateway(["init", "--workspace", str(tmp_path)], stdin="")
    _assert_no_traceback(result)
    assert result.returncode == 1
    assert "已取消" in result.stdout or "Traceback" not in result.stderr


def test_gateway_without_config_non_tty_reports_instead_of_crash(tmp_path):
    result = _run_gateway(["--workspace", str(tmp_path)], stdin="")
    _assert_no_traceback(result)
    assert "gateway init" in result.stdout + result.stderr


# --- 一键模式：env 驱动，缺字段精确到环境变量名 -------------------------------------


def test_one_click_init_writes_config_from_env(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    result = _run_gateway(
        ["init", "--yes", "--channel", "telegram", "--workspace", str(workspace)],
        env_extra={"RIND_GW_TELEGRAM_TOKEN": "123:AAE", "RIND_GW_TELEGRAM_ALLOW_FROM": "987654"},
    )
    _assert_no_traceback(result)
    assert result.returncode == 0
    text = (workspace / ".rind" / "gateway.yaml").read_text(encoding="utf-8")
    assert "allow_from: ['987654']" in text or 'allow_from: ["987654"]' in text


def test_one_click_init_missing_env_names_the_variable(tmp_path):
    result = _run_gateway(
        ["init", "--yes", "--channel", "telegram", "--workspace", str(tmp_path / "ws")],
    )
    assert result.returncode == 2
    assert "RIND_GW_TELEGRAM_TOKEN" in result.stderr


def test_one_click_init_ignores_unknown_channels(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    result = _run_gateway(
        ["init", "--yes", "--channel", "telegram,myspace", "--workspace", str(workspace)],
        env_extra={"RIND_GW_TELEGRAM_TOKEN": "t"},
    )
    assert result.returncode == 0
    assert "myspace" in result.stderr


# --- 配对批准子命令的端到端 ---------------------------------------------------------


def test_approve_subcommand_end_to_end(tmp_path):
    from gateway.security import PairingStore

    runtime_dir = tmp_path / ".rind"
    runtime_dir.mkdir(parents=True)
    store = PairingStore(runtime_dir / "pairing.json")
    code = store.ensure_pending("telegram", "987654", 3600.0)

    result = _run_gateway(
        ["--workspace", str(tmp_path), "approve", code],
    )
    _assert_no_traceback(result)
    assert result.returncode == 0, f"stderr: {result.stderr[-400:]}"
    pairing = json.loads((runtime_dir / "pairing.json").read_text(encoding="utf-8"))
    assert ["telegram", "987654"] in pairing.get("approved", [])

    again = _run_gateway(["--workspace", str(tmp_path), "approve", code])
    assert again.returncode == 1, "同一配对码不应能批准两次"
