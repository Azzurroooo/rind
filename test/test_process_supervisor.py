from __future__ import annotations

import asyncio
import json
import shlex
import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.tools.shell import process_tree
from agent.infrastructure.tools.shell.session_pool import ShellSessionPool, ShellState
from agent.infrastructure.tools.shell.supervisor import ProcessSupervisor


def _payload(result) -> dict:
    return json.loads(result.result_str)


def _shell_quote(state: ShellState, value: str) -> str:
    if state.shell_backend == "powershell":
        return "'" + value.replace("'", "''") + "'"
    return shlex.quote(value.replace("\\", "/"))


def _script_command(state: ShellState, path: Path, *args: Path) -> str:
    executable = _shell_quote(state, str(Path(sys.executable).resolve()))
    command = " ".join([executable, _shell_quote(state, str(path)), *(
        _shell_quote(state, str(arg)) for arg in args
    )])
    return f"& {command}" if state.shell_backend == "powershell" else command


@pytest.mark.asyncio
async def test_cancel_terminates_descendant_process(tmp_path: Path) -> None:
    marker = tmp_path / "child-finished"
    started = tmp_path / "child-started"
    child = tmp_path / "child.py"
    child.write_text(
        "import pathlib, time\ntime.sleep(2)\npathlib.Path(__file__).with_name('child-finished').write_text('alive')\n",
        encoding="utf-8",
    )
    parent = tmp_path / "parent.py"
    parent.write_text(
        "import pathlib, subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, sys.argv[1]])\n"
        "pathlib.Path(sys.argv[2]).write_text('spawned')\n"
        "print('spawned', flush=True)\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    state = ShellState(
        cwd=str(tmp_path),
        env={},
        shell_executable=sys.executable,
        shell_backend="bash",
    )
    command = (
        f"import runpy, sys; sys.argv = [{str(parent)!r}, {str(child)!r}, {str(started)!r}]; "
        f"runpy.run_path({str(parent)!r}, run_name='__main__')"
    )
    source = CancellationTokenSource()
    supervisor = ProcessSupervisor()
    run = asyncio.create_task(supervisor.run(command, state, "tree", source.token))
    for _ in range(20):
        if started.exists():
            break
        await asyncio.sleep(0.05)
    assert started.exists()
    source.cancel("test")
    result = await run

    assert _payload(result)["data"]["status"] == "cancelled"
    await asyncio.sleep(2)
    assert marker.exists() is False


@pytest.mark.asyncio
async def test_inherited_output_pipe_does_not_block_parent_completion(tmp_path: Path) -> None:
    child = tmp_path / "pipe_child.py"
    child.write_text("import time\ntime.sleep(5)\n", encoding="utf-8")
    parent = tmp_path / "pipe_parent.py"
    parent.write_text(
        "import subprocess, sys\n"
        "subprocess.Popen([sys.executable, sys.argv[1]])\n"
        "print('parent done', flush=True)\n",
        encoding="utf-8",
    )
    state = ShellSessionPool().get_state("pipes")
    command = _script_command(state, parent, child)
    supervisor = ProcessSupervisor()

    started = time.monotonic()
    result = await supervisor.run(command, state, "pipes")

    assert time.monotonic() - started < 3
    assert _payload(result)["data"]["status"] == "completed"


def test_process_group_spawn_options_cover_both_platforms(monkeypatch) -> None:
    monkeypatch.setattr(process_tree, "WINDOWS", False)
    assert process_tree.spawn_group_args() == {"start_new_session": True}

    monkeypatch.setattr(process_tree, "WINDOWS", True)
    assert process_tree.spawn_group_args()["creationflags"] != 0


class _FakeProcess:
    pid = 123
    returncode = None

    def __init__(self) -> None:
        self.killed = False

    async def wait(self) -> int:
        self.returncode = 0
        return 0

    def kill(self) -> None:
        self.killed = True


@pytest.mark.asyncio
async def test_windows_tree_kill_falls_back_to_parent(monkeypatch) -> None:
    process = _FakeProcess()
    async def taskkill(_pid: int) -> bool:
        return False

    monkeypatch.setattr(process_tree, "WINDOWS", True)
    monkeypatch.setattr(process_tree, "_taskkill", taskkill)
    await process_tree.terminate_tree(process, 1)

    assert process.killed is True


@pytest.mark.asyncio
async def test_unix_tree_kill_targets_process_group(monkeypatch) -> None:
    process = _FakeProcess()
    signals: list[int] = []
    monkeypatch.setattr(process_tree, "WINDOWS", False)
    monkeypatch.setattr(
        process_tree.os,
        "killpg",
        lambda pid, sent_signal: signals.append(sent_signal),
        raising=False,
    )
    await process_tree.terminate_tree(process, 1)

    assert signals == [process_tree._SIGTERM, process_tree._SIGKILL]
