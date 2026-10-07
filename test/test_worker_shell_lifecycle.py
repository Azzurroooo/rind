import asyncio
import json
import shlex
import sys
from types import SimpleNamespace

import pytest

from agent.runtime.server.worker import RuntimeWorker
from agent.infrastructure.tools.shell.session_pool import ShellState


@pytest.mark.asyncio
async def test_workers_own_shells_and_idle_preserves_backgrounds(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    workers = [
        RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / str(index)))
        for index in range(2)
    ]
    first, second = workers
    sid = "shared-id"
    state = first.shell_tools.pool.get_state(sid, str(tmp_path))
    code = "import time; time.sleep(60)"
    if state.shell_backend == "powershell":
        executable = sys.executable.replace("'", "''")
        command = f"& '{executable}' -c '{code}'"
    else:
        command = f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"
    try:
        result = json.loads(await first.shell_tools.bash(command, yield_time_ms=0, _session_id=sid))
        bg_id = result["data"]["task_id"]
        assert await second.shell_tools.list_backgrounds(sid) == []

        async def close_client():
            pass

        execution = SimpleNamespace(
            current_cancel=None, queued_turn_starts=0,
            container=SimpleNamespace(
                runtime=SimpleNamespace(turn_active=False),
                chat_client=SimpleNamespace(close=close_client),
            ),
        )
        first.execution._active[sid] = execution
        await first.execution._release_if_idle(sid, execution)
        assert (await first.shell_tools.snapshot_background(bg_id, _session_id=sid))["status"] == "running"
        await first.shell_tools.close_session(sid)
        assert (await first.shell_tools.snapshot_background(bg_id, _session_id=sid))["status"] == "cancelled"
        assert await second.shell_tools.list_backgrounds(sid) == []
    finally:
        for worker in workers:
            await worker.close()
            await worker.close()


@pytest.mark.asyncio
async def test_worker_stops_shells_while_execution_cleanup_is_blocked(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    state = ShellState(cwd=str(tmp_path), env={}, shell_executable=sys.executable)
    release = asyncio.Event()
    close_execution = worker.execution.close

    async def slow_close():
        await release.wait()
        await close_execution()

    monkeypatch.setattr(worker.execution, "close", slow_close)
    closing = None
    try:
        result = await worker.shell_tools.supervisor.run("import time; time.sleep(60)", state, "owned", yield_time_ms=0)
        record = worker.shell_tools.supervisor._processes[json.loads(result.result_str)["data"]["task_id"]]
        closing = asyncio.create_task(worker.close())
        await asyncio.wait_for(record.finished.wait(), 5)
        assert record.process.returncode is not None
        assert record.status == "cancelled"
        assert not closing.done()
    finally:
        release.set()
        if closing is not None:
            await closing
        await worker.close()
