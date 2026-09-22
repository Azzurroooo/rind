"""Wait behavior uses controlled processes instead of multi-second sleeps."""
import asyncio
import json

import pytest

from test_shell_tasks import task_shell, data


@pytest.mark.asyncio
async def test_continuous_output_does_not_release_wait(task_shell):
    tools, processes = task_shell
    task = data(await tools.bash("work", yield_time_ms=0))
    waiting = asyncio.create_task(tools.task_control("wait", task["task_id"]))
    for _ in range(20):
        processes[0].stdout.feed_data(b"progress\r")
        await asyncio.sleep(0)
        assert not waiting.done()
    processes[0].finish(stdout=b"tail\n")
    result = data(await waiting)
    assert result["status"] == "completed" and "tail\n" in result["stdout"]


@pytest.mark.asyncio
async def test_short_command_finishes_in_initial_call(task_shell):
    tools, processes = task_shell
    call = asyncio.create_task(tools.bash("work"))
    while not processes:
        await asyncio.sleep(0)
    processes[0].finish(stdout=b"done\n")
    result = data(await call)
    assert result["task_id"] and result["return_reason"] == "finished"
    assert result["stdout"] == "done\n"


@pytest.mark.asyncio
async def test_cancelling_wait_coroutine_does_not_cancel_process(task_shell):
    tools, processes = task_shell
    result = data(await tools.bash("work", yield_time_ms=0))
    waiting = asyncio.create_task(tools.task_control("wait", result["task_id"]))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert processes[0].returncode is None
    assert data(await tools.task_control("read", result["task_id"]))["status"] == "running"


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", [
    {"action": "read", "task_id": "missing", "wait_ms": 1000},
    {"action": "cancel", "task_id": "missing", "cursor": "x"},
    {"action": "list", "task_id": "missing"},
    {"action": "wait", "task_id": "missing", "wait_ms": 999},
    {"action": "wait", "task_id": "missing", "wait_ms": 60001},
    {"action": "read"},
])
async def test_control_rejects_invalid_combinations(task_shell, arguments):
    tools, _ = task_shell
    result = json.loads(await tools.task_control(**arguments))
    assert result["error_type"] == "InvalidArguments"


@pytest.mark.asyncio
async def test_unknown_legacy_task_is_not_restarted(task_shell):
    tools, processes = task_shell
    result = json.loads(await tools.bash_output("bg_missing"))
    assert result["error_type"] == "NotFound"
    assert "will not be restarted" in result["error"]
    assert not processes
