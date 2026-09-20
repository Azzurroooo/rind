import asyncio
import json
import os
import shlex
import sys
import time
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource




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


def shell_quote_python(shell_tools, code: str, sid: str) -> str:
    state = shell_tools.pool.get_state(sid)
    exe = sys.executable
    if state.shell_backend == "powershell":
        return f"& {ps_quote(exe)} -c {ps_quote(code)}"
    executable = exe.replace("\\", "/")
    return f"{shlex.quote(executable)} -c {shlex.quote(code)}"


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


async def start_background(shell_tools, sid: str, code: str, wait_ms: int = 1000) -> dict:
    command = shell_quote_python(shell_tools, code, sid)
    data = assert_ok(await shell_tools.bash(command, _session_id=sid, run_in_background=True, wait_ms=wait_ms))
    if not data.get("bg_id"):
        raise AssertionError(f"Expected background process, got: {data}")
    return data


@pytest.mark.asyncio
async def test_bash_background_initial_wait_returns_completed_result(shell_tools) -> None:
    sid = session_id("initial_wait")
    command = shell_quote_python(shell_tools, "print('done', flush=True)", sid)
    data = assert_ok(await shell_tools.bash(command, _session_id=sid, run_in_background=True, wait_ms=5000))

    assert data.get("exit_code") == 0
    assert "done" in (data.get("stdout") or "")
    assert "bg_id" not in data


@pytest.mark.asyncio
async def test_bash_foreground_ignores_wait_ms(shell_tools) -> None:
    sid = session_id("foreground_wait")
    command = shell_quote_python(shell_tools,
        "import time; time.sleep(1.2); print('done', flush=True)",
        sid,
    )
    started = time.monotonic()
    data = assert_ok(await shell_tools.bash(command, _session_id=sid, run_in_background=False, wait_ms=1000))
    elapsed = time.monotonic() - started

    assert elapsed >= 1.0
    assert data.get("exit_code") == 0
    assert "done" in (data.get("stdout") or "")
    assert "bg_id" not in data


@pytest.mark.asyncio
async def test_bash_output_waits_until_deadline_with_continuous_output(shell_tools) -> None:
    sid = session_id("wait_output")
    bg_id = ""
    try:
        bg = await start_background(shell_tools,
            sid,
            "import time; [(print(f'line{i}', flush=True), time.sleep(0.3)) for i in range(8)]; time.sleep(10)",
        )
        bg_id = bg["bg_id"]
        started = time.monotonic()
        data = assert_ok(await shell_tools.bash_output(bg_id, wait_ms=5000, _session_id=sid))
        elapsed = time.monotonic() - started

        assert elapsed >= 4.5
        assert data.get("status") == "running"
        assert data.get("delta") is True
        assert "line" in (data.get("stdout") or "")
        assert data.get("no_new_output") is False
    finally:
        if bg_id:
            await shell_tools.bash_output(bg_id, kill=True, _session_id=sid)


@pytest.mark.asyncio
async def test_bash_output_wait_no_new_output(shell_tools) -> None:
    sid = session_id("no_output")
    bg_id = ""
    try:
        bg = await start_background(shell_tools, sid, "import time; time.sleep(10)")
        bg_id = bg["bg_id"]
        started = time.monotonic()
        data = assert_ok(await shell_tools.bash_output(bg_id, wait_ms=1500, _session_id=sid))
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
            await shell_tools.bash_output(bg_id, kill=True, _session_id=sid)


@pytest.mark.asyncio
async def test_bash_output_clamps_short_wait_to_minimum(shell_tools) -> None:
    sid = session_id("short_wait_clamp")
    bg_id = ""
    try:
        bg = await start_background(shell_tools, sid, "import time; time.sleep(1.4); print('ready', flush=True); time.sleep(10)")
        bg_id = bg["bg_id"]
        data = assert_ok(await shell_tools.bash_output(bg_id, wait_ms=1, _session_id=sid))

        assert data.get("wait_ms") == 5000
        assert "ready" in (data.get("stdout") or "")
        assert data.get("no_new_output") is False
    finally:
        if bg_id:
            await shell_tools.bash_output(bg_id, kill=True, _session_id=sid)


@pytest.mark.asyncio
async def test_bash_output_clamps_large_wait_to_maximum(shell_tools) -> None:
    sid = session_id("large_wait_clamp")
    bg_id = ""
    try:
        bg = await start_background(shell_tools, sid, "import time; time.sleep(1.4); print('ready', flush=True)")
        bg_id = bg["bg_id"]
        data = assert_ok(await shell_tools.bash_output(bg_id, wait_ms=999999, _session_id=sid))

        assert data.get("wait_ms") == 300000
        assert "ready" in (data.get("stdout") or "")
        assert data.get("no_new_output") is False
    finally:
        if bg_id:
            await shell_tools.bash_output(bg_id, kill=True, _session_id=sid)


@pytest.mark.asyncio
async def test_bash_output_returns_delta_only(shell_tools) -> None:
    sid = session_id("delta_only")
    bg_id = ""
    try:
        bg = await start_background(shell_tools,
            sid,
            "import time; time.sleep(1.6); print('one', flush=True); "
            "time.sleep(5); print('two', flush=True); time.sleep(2)",
        )
        bg_id = bg["bg_id"]
        first = assert_ok(await shell_tools.bash_output(bg_id, wait_ms=5000, _session_id=sid))
        second = assert_ok(await shell_tools.bash_output(bg_id, wait_ms=5000, _session_id=sid))

        assert "one" in (first.get("stdout") or "")
        assert "two" not in (first.get("stdout") or "")
        assert "two" in (second.get("stdout") or "")
        assert "one" not in (second.get("stdout") or "")
    finally:
        if bg_id:
            await shell_tools.bash_output(bg_id, kill=True, _session_id=sid)


@pytest.mark.asyncio
async def test_bash_output_reports_done_and_exit_code(shell_tools) -> None:
    sid = session_id("done_exit")
    bg = await start_background(shell_tools,
        sid,
        "import time, sys; time.sleep(1.6); print('done', flush=True); sys.exit(7)",
    )
    started = time.monotonic()
    data = assert_ok(await shell_tools.bash_output(bg["bg_id"], wait_ms=5000, _session_id=sid))
    elapsed = time.monotonic() - started

    assert elapsed < 4.5
    assert data.get("status") == "failed"
    assert data.get("exit_code") == 7
    assert data.get("stdout") == "done"


@pytest.mark.asyncio
async def test_bash_output_reports_not_found(shell_tools) -> None:
    payload = parse_payload(await shell_tools.bash_output("bg_missing_for_test", wait_ms=1000))

    assert payload.get("ok") is False
    assert payload.get("tool") == "bash_output"
    assert payload.get("error_type") == "NotFound"


@pytest.mark.asyncio
async def test_bash_output_kill_settles_background_tasks(shell_tools) -> None:
    sid = session_id("kill_settles")
    bg = await start_background(shell_tools, sid, "import time; time.sleep(10)", wait_ms=1000)

    data = assert_ok(await shell_tools.bash_output(bg["bg_id"], kill=True, _session_id=sid))
    pending = [
        task for task in asyncio.all_tasks()
        if task is not asyncio.current_task() and not task.done()
    ]

    assert data.get("status") == "cancelled"
    assert pending == []


@pytest.mark.asyncio
async def test_bash_background_initial_wait_cancellation_kills_process(shell_tools) -> None:
    sid = session_id("initial_wait_cancel")
    source = CancellationTokenSource()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.1)
        source.cancel("test interrupt")

    asyncio.create_task(cancel_soon())
    command = shell_quote_python(shell_tools, "import time; time.sleep(10)", sid)
    data = assert_ok(
        await shell_tools.bash(
            command,
            _session_id=sid,
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
        for bg_id, bg in shell_tools.supervisor._processes.items()
        if getattr(bg, "session_id", None) == sid
    ]
    assert pending == []


@pytest.mark.asyncio
async def test_bash_output_wait_cancellation_kills_process(shell_tools) -> None:
    sid = session_id("output_wait_cancel")
    bg_id = ""
    source = CancellationTokenSource()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.1)
        source.cancel("test interrupt")

    try:
        bg = await start_background(shell_tools, sid, "import time; time.sleep(5)", wait_ms=1000)
        bg_id = bg["bg_id"]
        asyncio.create_task(cancel_soon())

        started = time.monotonic()
        payload = parse_payload(
            await shell_tools.bash_output(
                bg_id,
                wait_ms=5000,
                _session_id=sid,
                _cancellation_token=source.token,
            )
        )
        elapsed = time.monotonic() - started

        assert elapsed < 2.0
        assert payload.get("ok") is True
        assert payload.get("data", {}).get("status") == "cancelled"
        assert bg_id not in shell_tools.supervisor._processes
    finally:
        if bg_id:
            await shell_tools.bash_output(bg_id, kill=True, _session_id=sid)


@pytest_asyncio.fixture
async def shell_tools(tmp_path):
    from agent.infrastructure.persistence import ToolOutputStore
    from agent.infrastructure.tools.shell.specs import ShellTools

    tools = ShellTools(ToolOutputStore(str(tmp_path)))
    try:
        yield tools
    finally:
        await tools.close()
