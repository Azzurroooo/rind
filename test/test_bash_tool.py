import asyncio
import json
import os
import shlex
import shutil
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools.builtin.shell.tool import _POOL, bash

@pytest.fixture
def temp_dir(tmp_path: Path) -> Path:
    """Provides a temporary directory for tests to run in."""
    return tmp_path

def run(coro):
    """Run an async bash call synchronously in tests."""
    return asyncio.run(coro)

def parse_payload(raw: str) -> dict:
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise AssertionError(f"Invalid payload: {raw}")
    return obj

def assert_ok(payload: dict) -> dict:
    if payload.get("ok") is not True:
        raise AssertionError(f"Expected ok=True, got: {payload}")
    return payload

def assert_error(payload: dict, error_type: str) -> dict:
    if payload.get("ok") is not False:
        raise AssertionError(f"Expected ok=False, got: {payload}")
    if payload.get("error_type") != error_type:
        raise AssertionError(f"Expected error_type={error_type}, got: {payload}")
    return payload

def test_echo() -> None:
    payload = assert_ok(parse_payload(run(bash("echo hello"))))
    data = payload.get("data") or {}
    stdout = (data.get("stdout") or "").lower()
    if "hello" not in stdout:
        raise AssertionError(f"Expected stdout to contain hello, got: {data}")
    if "cwd" not in data:
        raise AssertionError(f"Expected cwd in data, got: {data}")
    meta = payload.get("meta") or {}
    if meta.get("truncated") is not False or meta.get("total_lines") != 1:
        raise AssertionError(f"Expected exact output metadata, got: {payload}")

def test_cd_is_scoped_to_one_command(temp_dir: Path) -> None:
    sid = f"test_cd_{temp_dir.name}"
    state = _POOL.get_state(sid)
    if state.shell_backend == "powershell":
        quoted_dir = str(temp_dir).replace("'", "''")
        in_dir_command = f"Set-Location -LiteralPath '{quoted_dir}'; (Get-Location).Path"
        cwd_command = "(Get-Location).Path"
    else:
        in_dir_command = f"cd -- {shlex.quote(temp_dir.as_posix())} && pwd"
        cwd_command = "pwd"

    payload = assert_ok(parse_payload(run(bash(in_dir_command, _session_id=sid))))
    data = payload.get("data") or {}
    stdout = (data.get("stdout") or "").strip()
    if temp_dir.name not in stdout:
        raise AssertionError(f"Expected command to run in {temp_dir}, got: {data}")

    payload = assert_ok(parse_payload(run(bash(cwd_command, _session_id=sid))))
    data = payload.get("data") or {}
    stdout = (data.get("stdout") or "").strip()
    if temp_dir.name in stdout:
        raise AssertionError(f"Expected the next command to use the session cwd, got: {data}")
    expected = os.path.abspath(str(PROJECT_ROOT))
    if data.get("cwd") != expected:
        raise AssertionError(f"Expected stable cwd={expected}, got: {data}")


def test_missing_cd_is_reported_by_shell(temp_dir: Path) -> None:
    sid = f"test_missing_cd_{temp_dir.name}"
    missing_dir = temp_dir / "does-not-exist"
    state = _POOL.get_state(sid)
    if state.shell_backend == "powershell":
        quoted_dir = str(missing_dir).replace("'", "''")
        command = f"Set-Location -LiteralPath '{quoted_dir}'"
    else:
        command = f"cd -- {shlex.quote(missing_dir.as_posix())}"

    payload = assert_ok(parse_payload(run(bash(command, _session_id=sid))))
    data = payload.get("data") or {}
    if data.get("status") != "failed" or not data.get("stderr"):
        raise AssertionError(f"Expected shell cd failure, got: {data}")

def test_forbidden_blocked() -> None:
    payload = assert_error(parse_payload(run(bash("shutdown -h now"))), "DangerousCommandBlocked")
    if payload.get("tool") != "bash":
        raise AssertionError(f"Expected tool=bash, got: {payload}")

def test_rm_allowed_by_default(temp_dir: Path) -> None:
    target = temp_dir / "delete-me.txt"
    target.write_text("delete", encoding="utf-8")
    session_id = f"test_rm_{temp_dir.name}"
    state = _POOL.get_state(session_id)
    if state.shell_backend == "powershell":
        command = f"rm -Force '{str(target).replace("'", "''")}'"
    else:
        command = f"rm -f {shlex.quote(target.as_posix())}"
    payload = assert_ok(parse_payload(run(bash(command, _session_id=session_id))))
    if payload.get("tool") != "bash":
        raise AssertionError(f"Expected tool=bash, got: {payload}")
    if target.exists():
        raise AssertionError("Expected rm to execute by default")

def main() -> int:
    temp_dir = PROJECT_ROOT / "test" / "__bash_tool_tmp__"
    if temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        test_echo()
        test_cd_and_cwd(temp_dir)
        test_forbidden_blocked()
        test_rm_allowed_by_default(temp_dir)
        print("All bash tool tests passed.")
        return 0
    finally:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

if __name__ == "__main__":
    raise SystemExit(main())
