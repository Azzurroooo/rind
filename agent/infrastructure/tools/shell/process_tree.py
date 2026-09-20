from __future__ import annotations

import asyncio
import os
import signal
import subprocess


WINDOWS = os.name == "nt"
_SIGTERM = signal.SIGTERM
_SIGKILL = getattr(signal, "SIGKILL", 9)


def spawn_group_args() -> dict:
    if WINDOWS:
        return {
            "creationflags": getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
            )
        }
    return {"start_new_session": True}


async def wait_parent_exit(process: asyncio.subprocess.Process) -> int:
    while process.returncode is None:
        await asyncio.sleep(0.05)
    return process.returncode


async def terminate_tree(
    process: asyncio.subprocess.Process, grace_seconds: float
) -> None:
    if WINDOWS:
        if not await _taskkill(process.pid):
            _kill_parent(process)
        return

    try:
        os.killpg(process.pid, _SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(
            asyncio.shield(wait_parent_exit(process)), grace_seconds
        )
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(process.pid, _SIGKILL)
    except ProcessLookupError:
        pass


def kill_tree_now(process: asyncio.subprocess.Process) -> None:
    if not WINDOWS:
        try:
            os.killpg(process.pid, _SIGKILL)
            return
        except ProcessLookupError:
            pass
    else:
        try:
            completed = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
            if completed.returncode == 0:
                return
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            pass
    _kill_parent(process)


async def _taskkill(pid: int) -> bool:
    try:
        process = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(pid),
            "/T",
            "/F",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return await process.wait() == 0
    except (FileNotFoundError, OSError):
        return False


def _kill_parent(process: asyncio.subprocess.Process) -> None:
    try:
        process.kill()
    except ProcessLookupError:
        pass
