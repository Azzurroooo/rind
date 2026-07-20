import asyncio
import importlib
import json
import os
import shlex
import sys
import time
import uuid
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.cancellation import CancellationTokenSource
from agent.infrastructure.tools.impl.tools.bash import bash, bash_output, kill_shell


bash_module = importlib.import_module("agent.infrastructure.tools.impl.tools.bash")


def parse_payload(raw: str) -> dict:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise AssertionError(f"Invalid payload: {raw}")
    return payload


def assert_ok(raw: str) -> dict:
    payload = parse_payload(raw)
    if payload.get("ok") is not True:
        raise AssertionError(f"Expected ok=True, got: {payload}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise AssertionError(f"Expected object data, got: {payload}")
    return data


def session_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def shell_quote_python(code: str, sid: str) -> str:
    state = bash_module._POOL.get_state(sid)
    exe = sys.executable
    if state.shell_backend == "powershell":
        return f"& {ps_quote(exe)} -c {ps_quote(code)}"
    executable = exe.replace("\\", "/")
    return f"{shlex.quote(executable)} -c {shlex.quote(code)}"


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


async def start_background(sid: str, code: str, wait_ms: int = 1000) -> dict:
    command = shell_quote_python(code, sid)
    data = assert_ok(await bash(command, session_id=sid, run_in_background=True, wait_ms=wait_ms))
    if not data.get("bg_id"):
        raise AssertionError(f"Expected background process, got: {data}")
    return data


def cleanup_session(sid: str) -> None:
    kill_shell(session_id=sid)


@pytest.mark.asyncio
async def test_bash_background_initial_wait_returns_completed_result() -> None:
    sid = session_id("initial_wait")
    try:
        command = shell_quote_python("print('done', flush=True)", sid)
        data = assert_ok(await bash(command, session_id=sid, run_in_background=True, wait_ms=5000))

        assert data.get("exit_code") == 0
        assert "done" in (data.get("stdout") or "")
        assert "bg_id" not in data
    finally:
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_foreground_ignores_wait_ms() -> None:
    sid = session_id("foreground_wait")
    try:
        command = shell_quote_python(
            "import time; time.sleep(1.2); print('done', flush=True)",
            sid,
        )
        started = time.monotonic()
        data = assert_ok(await bash(command, session_id=sid, run_in_background=False, wait_ms=1000))
        elapsed = time.monotonic() - started

        assert elapsed >= 1.0
        assert data.get("exit_code") == 0
        assert "done" in (data.get("stdout") or "")
        assert "bg_id" not in data
    finally:
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_wait_returns_when_new_output_arrives() -> None:
    sid = session_id("wait_output")
    bg_id = ""
    try:
        bg = await start_background(
            sid,
            "import time; time.sleep(1.8); print('ready', flush=True); time.sleep(3)",
        )
        bg_id = bg["bg_id"]
        started = time.monotonic()
        data = assert_ok(await bash_output(bg_id, wait_ms=5000))
        elapsed = time.monotonic() - started

        assert elapsed < 4.5
        assert data.get("status") == "running"
        assert data.get("delta") is True
        assert "ready" in (data.get("stdout") or "")
        assert data.get("no_new_output") is False
    finally:
        if bg_id:
            await bash_output(bg_id, kill=True)
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_wait_no_new_output() -> None:
    sid = session_id("no_output")
    bg_id = ""
    try:
        bg = await start_background(sid, "import time; time.sleep(10)")
        bg_id = bg["bg_id"]
        started = time.monotonic()
        data = assert_ok(await bash_output(bg_id, wait_ms=1500))
        elapsed = time.monotonic() - started

        assert elapsed >= 4.5
        assert data.get("wait_ms") == 5000
        assert data.get("status") == "running"
        assert data.get("no_new_output") is True
        assert data.get("stdout") == ""
        assert data.get("stderr") == ""
        assert data.get("suggested_next_wait_ms") == 120000
    finally:
        if bg_id:
            await bash_output(bg_id, kill=True)
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_clamps_short_wait_to_minimum() -> None:
    sid = session_id("short_wait_clamp")
    bg_id = ""
    try:
        bg = await start_background(sid, "import time; time.sleep(1.4); print('ready', flush=True); time.sleep(10)")
        bg_id = bg["bg_id"]
        data = assert_ok(await bash_output(bg_id, wait_ms=1))

        assert data.get("wait_ms") == 5000
        assert "ready" in (data.get("stdout") or "")
        assert data.get("no_new_output") is False
    finally:
        if bg_id:
            await bash_output(bg_id, kill=True)
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_clamps_large_wait_to_maximum_without_long_sleep() -> None:
    sid = session_id("large_wait_clamp")
    bg_id = ""
    try:
        bg = await start_background(sid, "import time; time.sleep(1.4); print('ready', flush=True); time.sleep(10)")
        bg_id = bg["bg_id"]
        data = assert_ok(await bash_output(bg_id, wait_ms=999999))

        assert data.get("wait_ms") == 300000
        assert "ready" in (data.get("stdout") or "")
        assert data.get("no_new_output") is False
    finally:
        if bg_id:
            await bash_output(bg_id, kill=True)
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_returns_delta_only() -> None:
    sid = session_id("delta_only")
    bg_id = ""
    try:
        bg = await start_background(
            sid,
            "import time; time.sleep(1.6); print('one', flush=True); "
            "time.sleep(1.6); print('two', flush=True); time.sleep(2)",
        )
        bg_id = bg["bg_id"]
        first = assert_ok(await bash_output(bg_id, wait_ms=5000))
        second = assert_ok(await bash_output(bg_id, wait_ms=5000))

        assert "one" in (first.get("stdout") or "")
        assert "two" not in (first.get("stdout") or "")
        assert "two" in (second.get("stdout") or "")
        assert "one" not in (second.get("stdout") or "")
    finally:
        if bg_id:
            await bash_output(bg_id, kill=True)
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_reports_done_and_exit_code() -> None:
    sid = session_id("done_exit")
    try:
        bg = await start_background(sid, "import time, sys; time.sleep(1.6); sys.exit(7)")
        data = assert_ok(await bash_output(bg["bg_id"], wait_ms=5000))

        assert data.get("status") == "done"
        assert data.get("exit_code") == 7
    finally:
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_reports_not_found() -> None:
    payload = parse_payload(await bash_output("bg_missing_for_test", wait_ms=1000))

    assert payload.get("ok") is False
    assert payload.get("tool") == "bash_output"
    assert payload.get("error_type") == "NotFound"


@pytest.mark.asyncio
async def test_bash_output_kill_settles_background_tasks() -> None:
    sid = session_id("kill_settles")
    bg = await start_background(sid, "import time; time.sleep(10)", wait_ms=1000)

    data = assert_ok(await bash_output(bg["bg_id"], kill=True))
    pending = [
        task for task in asyncio.all_tasks()
        if task is not asyncio.current_task() and not task.done()
    ]

    assert data.get("status") == "killed"
    assert pending == []
    cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_background_initial_wait_cancellation_kills_process() -> None:
    sid = session_id("initial_wait_cancel")
    source = CancellationTokenSource()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.1)
        source.cancel("test interrupt")

    try:
        asyncio.create_task(cancel_soon())
        command = shell_quote_python("import time; time.sleep(10)", sid)
        data = assert_ok(
            await bash(
                command,
                session_id=sid,
                run_in_background=True,
                wait_ms=5000,
                _cancellation_token=source.token,
            )
        )
        pending = [
            task for task in asyncio.all_tasks()
            if task is not asyncio.current_task() and not task.done()
        ]

        assert data.get("status") == "cancelled"
        assert "PROCESS TERMINATED: Command cancelled: test interrupt" in (data.get("stderr") or "")
        assert not [
            bg_id
            for bg_id, bg in bash_module._RUNNER._bg.items()
            if getattr(bg, "session_id", None) == sid
        ]
        assert pending == []
    finally:
        cleanup_session(sid)


@pytest.mark.asyncio
async def test_bash_output_wait_cancellation_returns_cancelled_without_killing_process() -> None:
    sid = session_id("output_wait_cancel")
    bg_id = ""
    source = CancellationTokenSource()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.1)
        source.cancel("test interrupt")

    try:
        bg = await start_background(sid, "import time; time.sleep(5)", wait_ms=1000)
        bg_id = bg["bg_id"]
        asyncio.create_task(cancel_soon())

        started = time.monotonic()
        payload = parse_payload(
            await bash_output(bg_id, wait_ms=5000, _cancellation_token=source.token)
        )
        elapsed = time.monotonic() - started

        assert elapsed < 2.0
        assert payload.get("ok") is False
        assert payload.get("error_type") == "Cancelled"
        assert bg_id in bash_module._RUNNER._bg
    finally:
        if bg_id:
            await bash_output(bg_id, kill=True)
        cleanup_session(sid)


def main() -> int:
    async def _run_all():
        await test_bash_background_initial_wait_returns_completed_result()
        await test_bash_foreground_ignores_wait_ms()
        await test_bash_output_wait_returns_when_new_output_arrives()
        await test_bash_output_wait_no_new_output()
        await test_bash_output_clamps_short_wait_to_minimum()
        await test_bash_output_clamps_large_wait_to_maximum_without_long_sleep()
        await test_bash_output_returns_delta_only()
        await test_bash_output_reports_done_and_exit_code()
        await test_bash_output_reports_not_found()
        await test_bash_output_kill_settles_background_tasks()
        await test_bash_background_initial_wait_cancellation_kills_process()
        await test_bash_output_wait_cancellation_returns_cancelled_without_killing_process()

    asyncio.run(_run_all())
    print("Bash background wait tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
