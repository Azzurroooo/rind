from __future__ import annotations

import asyncio
import os
import signal


WINDOWS = os.name == "nt"
_SIGTERM = signal.SIGTERM
_SIGKILL = getattr(signal, "SIGKILL", 9)


def spawn_group_args() -> dict:
    if WINDOWS:
        return {
            "creationflags": 0x00000200 | 0x00000004 | 0x08000000,
        }
    return {"start_new_session": True}


def own_process_tree(process: asyncio.subprocess.Process) -> int | None:
    if WINDOWS and isinstance(process, asyncio.subprocess.Process):
        from agent.infrastructure.tools.shell.windows_job import attach
        return attach(process)
    return None


def close_process_tree(job: int | None) -> None:
    if job is not None:
        from agent.infrastructure.tools.shell.windows_job import close
        close(job)


async def wait_parent_exit(process: asyncio.subprocess.Process) -> int:
    while process.returncode is None:
        await asyncio.sleep(0.05)
    return process.returncode


async def terminate_tree(
    process: asyncio.subprocess.Process, grace_seconds: float, job: int | None = None
) -> None:
    if WINDOWS:
        if job is not None:
            from agent.infrastructure.tools.shell.windows_job import terminate
            terminate(job)
        else:
            _kill_parent(process)
        return

    try:
        os.killpg(process.pid, _SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(
            wait_parent_exit(process), grace_seconds
        )
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(process.pid, _SIGKILL)
    except ProcessLookupError:
        pass


def kill_tree_now(process: asyncio.subprocess.Process, job: int | None = None) -> None:
    if not WINDOWS:
        try:
            os.killpg(process.pid, _SIGKILL)
            return
        except ProcessLookupError:
            pass
    else:
        if job is not None:
            from agent.infrastructure.tools.shell.windows_job import terminate
            terminate(job)
            return
    _kill_parent(process)


def _kill_parent(process: asyncio.subprocess.Process) -> None:
    try:
        process.kill()
    except ProcessLookupError:
        pass
