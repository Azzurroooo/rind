"""OS-level single-instance file lock for the Rind runtime worker."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from agent.infrastructure.paths import resolve_rind_home

if os.name == "nt":
    import msvcrt
else:
    import fcntl


@dataclass
class WorkerLock:
    path: Path
    _fd: int | None

    def release(self) -> None:
        fd = self._fd
        if fd is None:
            return
        self._fd = None
        try:
            if os.name == "nt":
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            try:
                os.close(fd)
            except OSError:
                pass


def _try_lock(fd: int) -> bool:
    try:
        if os.name == "nt":
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _read_holder_pid(fd: int) -> str:
    try:
        os.lseek(fd, 1, os.SEEK_SET)
        text = os.read(fd, 64).decode("utf-8", errors="ignore").strip()
        return text or "unknown"
    except OSError:
        return "unknown"


def acquire_worker_lock(session_dir: str | None = None, *, wait_seconds: float = 0.0) -> WorkerLock:
    rind_home = resolve_rind_home()
    default_sessions = (rind_home / "sessions").resolve()
    resolved_session_dir = Path(session_dir).expanduser().resolve() if session_dir else default_sessions
    if os.path.normcase(str(resolved_session_dir)) == os.path.normcase(str(default_sessions)):
        lock_path = rind_home / "runtime" / "worker.lock"
        target = str(rind_home)
    else:
        lock_path = resolved_session_dir / ".worker.lock"
        target = str(resolved_session_dir)

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while not _try_lock(fd):
        if time.monotonic() >= deadline:
            holder = _read_holder_pid(fd)
            try:
                os.close(fd)
            except OSError:
                pass
            raise RuntimeError(f"Another Rind runtime worker is already running for {target} (pid {holder}).")
        time.sleep(0.05)

    try:
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, f" {os.getpid()}\n".encode("ascii"))
    except OSError:
        pass
    return WorkerLock(path=lock_path, _fd=fd)
