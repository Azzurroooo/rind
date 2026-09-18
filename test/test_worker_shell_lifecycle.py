import json
import shlex
import sys
from types import SimpleNamespace

import pytest

from agent.runtime.server.worker import RuntimeWorker


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
        result = json.loads(await first.shell_tools.bash(command, True, 1000, sid))
        bg_id = result["data"]["bg_id"]
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
        assert await first.shell_tools.list_backgrounds(sid) == []
        assert await second.shell_tools.list_backgrounds(sid) == []
    finally:
        for worker in workers:
            await worker.close()
            await worker.close()
