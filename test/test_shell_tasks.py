import asyncio
import json
import sys

import pytest
import pytest_asyncio

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.persistence import ToolOutputStore
from agent.infrastructure.tools.registry import DefaultToolRegistry
from agent.infrastructure.tools.shell.session_pool import ShellState
from agent.infrastructure.tools.shell.specs import build_shell_tool_specs
from agent.infrastructure.tools.shell.tool import ShellTools


class FakeProcess:
    pid = 101

    def __init__(self):
        self.returncode = None
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.exited = asyncio.Event()

    def finish(self, code=0, stdout=b"", stderr=b""):
        self.returncode = code
        self.stdout.feed_data(stdout)
        self.stderr.feed_data(stderr)
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.exited.set()


@pytest_asyncio.fixture
async def task_shell(tmp_path, monkeypatch):
    from agent.infrastructure.tools.shell import supervisor
    tools = ShellTools(ToolOutputStore(str(tmp_path)))
    spawned = []

    async def spawn(*args, **kwargs):
        process = FakeProcess()
        spawned.append(process)
        return process

    async def wait(process):
        await process.exited.wait()
        return process.returncode

    async def terminate(process, grace):
        if process.returncode is None:
            process.finish(-9)

    monkeypatch.setattr(supervisor.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(supervisor, "wait_parent_exit", wait)
    monkeypatch.setattr(supervisor, "terminate_tree", terminate)
    try:
        yield tools, spawned
    finally:
        await tools.close()


def data(raw):
    payload = json.loads(raw)
    assert payload["ok"], payload
    return payload["data"]


@pytest.mark.asyncio
async def test_yield_reuse_nonzero_repeatable_reads_and_session_isolation(task_shell):
    tools, processes = task_shell
    first = data(await tools.bash("work", yield_time_ms=0, _idempotency_key="origin"))
    assert first["status"] == "running" and first["exit_code"] is None
    repeated = data(await tools.bash("work", yield_time_ms=0, _idempotency_key="origin"))
    assert repeated["task_id"] == first["task_id"] and len(processes) == 1
    processes[0].finish(7, b"  tail\n", b"error\r")
    result = data(await tools.task_control("wait", first["task_id"]))
    assert result["status"] == "failed" and result["exit_code"] == 7
    assert result["stdout"] == "  tail\n" and result["stderr"] == "error\r"
    assert data(await tools.task_control("read", first["task_id"])) == result
    assert data(await tools.task_control("cancel", first["task_id"])) == result
    assert not json.loads(await tools.task_control("read", first["task_id"], _session_id="other"))["ok"]


@pytest.mark.asyncio
async def test_release_and_cancel_observation_keep_original_process(task_shell):
    tools, processes = task_shell
    call = asyncio.create_task(tools.bash("work", yield_time_ms=60000, _idempotency_key="release"))
    for _ in range(10):
        await asyncio.sleep(0)
        if tools.supervisor.release_wait("default", call_id="release"):
            break
    result = data(await asyncio.wait_for(call, 1))
    assert result["status"] == "running" and result["return_reason"] == "released"
    cancellation = CancellationTokenSource()
    cancellation.cancel("stop observing")
    read = data(await tools.task_control("wait", result["task_id"], _cancellation_token=cancellation.token))
    assert read["return_reason"] == "interrupted" and read["status"] == "running"
    assert processes[0].returncode is None and len(processes) == 1
    cancelled = data(await tools.task_control("cancel", result["task_id"]))
    assert cancelled["status"] == "cancelled"
    assert processes[0].returncode == -9


@pytest.mark.asyncio
async def test_initial_interrupt_terminates_unhanded_process(task_shell):
    tools, processes = task_shell
    cancellation = CancellationTokenSource()
    cancellation.cancel("initial interruption")
    result = data(await tools.bash("work", _cancellation_token=cancellation.token))
    assert result["status"] == "cancelled" and processes[0].returncode == -9


@pytest.mark.asyncio
async def test_quota_reserved_before_spawn_and_terminal_releases_slot(task_shell):
    tools, processes = task_shell
    tools.supervisor.max_tasks = 1
    results = await asyncio.gather(*(tools.bash("work", yield_time_ms=0) for _ in range(8)))
    success = [data(result) for result in results if json.loads(result)["ok"]]
    assert len(success) == len(processes) == 1
    processes[0].finish()
    await tools.task_control("wait", success[0]["task_id"])
    assert data(await tools.bash("work", yield_time_ms=0))["status"] == "running"


@pytest.mark.asyncio
async def test_deadline_is_independent_of_yield(task_shell, monkeypatch):
    tools, processes = task_shell
    expired = asyncio.Event()
    original_deadline = tools.supervisor._deadline

    async def controlled_deadline(record, timeout_ms):
        assert timeout_ms == 120001
        await expired.wait()
        await original_deadline(record, 0)

    monkeypatch.setattr(tools.supervisor, "_deadline", controlled_deadline)
    result = data(await tools.bash("work", yield_time_ms=0, timeout_ms=120001))
    assert processes[0].returncode is None
    expired.set()
    terminal = data(await tools.task_control("wait", result["task_id"]))
    assert terminal["status"] == "timed_out"


@pytest.mark.asyncio
async def test_registry_new_schema_and_legacy_recovery(task_shell):
    tools, processes = task_shell
    registry = DefaultToolRegistry(build_shell_tool_specs(tools))
    schemas = {s["function"]["name"]: s["function"]["parameters"] for s in registry.schemas}
    assert set(schemas) == {"bash", "task_control"}
    assert set(schemas["bash"]["properties"]) == {"command", "cwd", "yield_time_ms", "timeout_ms", "notify"}
    result = data(await registry.call_async("bash", {"command": "work", "run_in_background": True, "wait_ms": 0}))
    assert result["status"] == "running"
    assert data(await registry.call_async("bash_output", {"bg_id": result["task_id"], "kill": True}))["status"] == "cancelled"
    conflict = json.loads(await registry.call_async("bash", {"command": "work", "run_in_background": True, "yield_time_ms": 0}))
    assert conflict["error_type"] == "InvalidArguments"
    assert len(processes) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", [{"yield_time_ms": True}, {"yield_time_ms": -1}, {"yield_time_ms": 60001}, {"timeout_ms": 0}, {"notify": "other"}])
async def test_bash_arguments_are_strict(task_shell, arguments):
    tools, processes = task_shell
    assert json.loads(await tools.bash("work", **arguments))["error_type"] == "InvalidArguments"
    assert not processes


@pytest.mark.asyncio
async def test_local_subprocess_short_command(tmp_path):
    tools = ShellTools(ToolOutputStore(str(tmp_path)))
    state = ShellState(cwd=str(tmp_path), env={}, shell_executable=sys.executable)
    try:
        result = await tools.supervisor.run("print('tail'); raise SystemExit(7)", state, "local", output_store=tools.output_store)
        payload = data(result.result_str)
        assert payload["status"] == "failed" and payload["exit_code"] == 7
        assert payload["stdout"] == "tail\r\n" if sys.platform == "win32" else payload["stdout"] == "tail\n"
    finally:
        await tools.close()
