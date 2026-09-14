"""Terminal-level user-channel tests: subprocesses with scripted stdin
simulate a real person typing line by line in PowerShell, covering the full
one-command gateway story. Any Traceback at any step fails the test.
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
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "RIND_GATEWAY_NO_AUTO_INSTALL": "1"})
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [PYTHON, str(PROJECT_ROOT / "main.py"), "gateway", *args],
        cwd=PROJECT_ROOT, env=env, input=stdin, capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )


def _assert_no_traceback(result: subprocess.CompletedProcess):
    combined = result.stdout + result.stderr
    assert "Traceback" not in combined, f"users must never see a stack trace:\n{combined[-800:]}"


# --- the full interactive wizard: a human's 22 keystrokes in the terminal -------------------------------------


def test_full_interactive_wizard_writes_working_config(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    lines = [
        "7,3",            # channel selection: telegram + email
        "",               # worker URL (default)
        str(workspace),   # working directory
        "",               # worker token (left empty)
        "123456:AAE",     # telegram token
        "",               # telegram proxy (direct)
        "",               # telegram allow_from
        "",               # telegram group_allow
        "n",              # skip the credential probe
        "n",              # skip ID discovery
        "",               # email imap_host (default)
        "",               # email imap_port (default)
        "",               # email smtp_host (default)
        "",               # email smtp_port (default)
        "me@qq.com",      # email username
        "auth-code",      # email password
        "",               # mailbox (default)
        "",               # poll_interval (default)
        "",               # email allow_from
        "",               # email group_allow
        "n",              # skip the credential probe
        "Y",              # confirm the write
    ]
    result = _run_gateway(["init"], stdin="\n".join(lines) + "\n", workspace=None)
    _assert_no_traceback(result)
    assert result.returncode == 0, f"stderr: {result.stderr[-600:]}"

    config_path = workspace / ".rind" / "gateway.yaml"
    assert config_path.exists(), f"config not written; stdout: {result.stdout[-600:]}"

    # the artifact must be readable by the real startup chain
    status = _run_gateway(
        ["status", "--config", str(config_path), "--workspace", str(workspace)],
    )
    _assert_no_traceback(status)
    assert "session mappings" in status.stdout and "channel Email" in status.stdout and "channel Telegram" in status.stdout

    doctor = _run_gateway(
        ["doctor", "--config", str(config_path), "--workspace", str(workspace)],
    )
    _assert_no_traceback(doctor)
    assert "config file" in doctor.stdout and "✔" in doctor.stdout


def test_wizard_defaults_skip_optional_fields(tmp_path):
    # Enter-all-the-way = telegram + email, the two zero-friction channels; email's required fields still need values.
    workspace = tmp_path / "ws"
    workspace.mkdir()
    lines = [
        "",               # channels (default telegram + email)
        "",               # worker
        str(workspace),   # workspace
        "",               # token
        "tok",            # telegram token
        "",               # telegram proxy (direct)
        "", "",           # telegram allow/group
        "n", "n",         # telegram probe/discovery
        "", "",           # email imap_host/port
        "", "",           # email smtp_host/port
        "me@qq.com",      # username
        "pw",             # password
        "", "",           # mailbox/poll
        "", "",           # email allow/group
        "n",              # email probe
        "Y",              # write
    ]
    result = _run_gateway(["init"], stdin="\n".join(lines) + "\n")
    _assert_no_traceback(result)
    assert (workspace / ".rind" / "gateway.yaml").exists()


# --- the original user crash: no config → wizard offered → EOF mid-way -----------------------------


def test_gateway_without_config_offers_wizard_and_cancels_cleanly(tmp_path):
    result = _run_gateway(["--workspace", str(tmp_path)], stdin="Y\n")
    _assert_no_traceback(result)
    assert "configuration wizard" in result.stdout
    assert "Cancelled (nothing written)" in result.stdout
    assert result.returncode == 1


def test_wizard_immediate_eof_cancels_cleanly(tmp_path):
    result = _run_gateway(["init", "--workspace", str(tmp_path)], stdin="")
    _assert_no_traceback(result)
    assert result.returncode == 1
    assert "Cancelled" in result.stdout or "Traceback" not in result.stderr


def test_gateway_without_config_non_tty_reports_instead_of_crash(tmp_path):
    result = _run_gateway(["--workspace", str(tmp_path)], stdin="")
    _assert_no_traceback(result)
    assert "gateway init" in result.stdout + result.stderr


# --- one-click mode: env-driven; a missing field names the exact variable -------------------------------------


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


# --- pairing approval subcommand, end to end ---------------------------------------------------------


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
    assert again.returncode == 1, "the same pairing code must not be approvable twice"
