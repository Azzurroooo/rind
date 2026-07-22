import asyncio
import json
import os
import shutil
import sys
import io
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools.builtin.shell.tool import bash, kill_shell

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

def set_env(value: str | None) -> None:
    if value is None:
        os.environ.pop("AGENT_ALLOW_UNSAFE_BASH", None)
    else:
        os.environ["AGENT_ALLOW_UNSAFE_BASH"] = value

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

def test_cd_and_cwd(temp_dir: Path) -> None:
    payload = assert_ok(parse_payload(run(bash(f"cd {str(temp_dir)}"))))
    data = payload.get("data") or {}
    expected = os.path.abspath(str(temp_dir))
    if data.get("cwd") != expected:
        raise AssertionError(f"Expected cwd={expected}, got: {data}")
    payload = assert_ok(parse_payload(run(bash("cd .."))))
    data = payload.get("data") or {}
    expected_parent = os.path.abspath(str(temp_dir.parent))
    if data.get("cwd") != expected_parent:
        raise AssertionError(f"Expected cwd={expected_parent}, got: {data}")

def test_kill_shell_resets(temp_dir: Path) -> None:
    assert_ok(parse_payload(run(bash(f"cd {str(temp_dir)}"))))
    payload = assert_ok(parse_payload(run(kill_shell())))
    if payload.get("tool") != "kill_shell":
        raise AssertionError(f"Expected tool=kill_shell, got: {payload}")
    payload = assert_ok(parse_payload(run(bash("cd ."))))
    data = payload.get("data") or {}
    expected = os.path.abspath(os.getcwd())
    if data.get("cwd") != expected:
        raise AssertionError(f"Expected cwd reset to {expected}, got: {data}")

def run_with_input(input_text: str, func):
    original_stdin = sys.stdin
    try:
        sys.stdin = io.StringIO(input_text)
        return func()
    finally:
        sys.stdin = original_stdin

def test_confirmable_requires_confirmation() -> None:
    # In Phase 2, confirmable commands without unsafe mode will return an error
    # instead of blocking with input().
    set_env(None)
    payload = assert_error(parse_payload(run(bash("rm __bash_tool_should_not_run__"))), "CommandRequiresApproval")
    if payload.get("tool") != "bash":
        raise AssertionError(f"Expected tool=bash, got: {payload}")

def test_forbidden_blocked() -> None:
    payload = assert_error(parse_payload(run(bash("shutdown -h now"))), "DangerousCommandBlocked")
    if payload.get("tool") != "bash":
        raise AssertionError(f"Expected tool=bash, got: {payload}")

def test_dangerous_allowed(temp_dir: Path) -> None:
    def call():
        return parse_payload(run(bash(f"rm -rf {str(temp_dir)}")))
    os.environ["AGENT_ALLOW_UNSAFE_BASH"] = "1"
    try:
        payload = assert_ok(call())
        if payload.get("tool") != "bash":
            raise AssertionError(f"Expected tool=bash, got: {payload}")
    finally:
        os.environ.pop("AGENT_ALLOW_UNSAFE_BASH", None)

def main() -> int:
    temp_dir = PROJECT_ROOT / "test" / "__bash_tool_tmp__"
    if temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True, exist_ok=True)

    original_env = os.environ.get("AGENT_ALLOW_UNSAFE_BASH")
    try:
        test_echo()
        test_cd_and_cwd(temp_dir)
        test_kill_shell_resets(temp_dir)
        set_env(None)
        set_env(None)
        test_confirmable_requires_confirmation()
        test_forbidden_blocked()
        set_env("1")
        test_dangerous_allowed(temp_dir)
        print("All bash tool tests passed.")
        return 0
    finally:
        if original_env is None:
            os.environ.pop("AGENT_ALLOW_UNSAFE_BASH", None)
        else:
            os.environ["AGENT_ALLOW_UNSAFE_BASH"] = original_env
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

if __name__ == "__main__":
    raise SystemExit(main())
