"""Cross-process Team workspace ownership."""

from __future__ import annotations

import os
from pathlib import Path

from agent.infrastructure.paths import resolve_rind_home

from .manifests import validate_id


class WorkspaceBusyError(RuntimeError):
    """Raised when a Team Agent workspace is already serving another turn."""


class WorkspaceLock:
    """A non-blocking, cross-process lock for one Team Agent workspace."""

    def __init__(self, project_id: str, agent_id: str) -> None:
        self._agent_id = validate_id(agent_id, "agent_id")
        self._path = resolve_rind_home() / "locks" / validate_id(project_id, "project_id") / f"{self._agent_id}.lock"
        self._handle = None

    @property
    def path(self) -> Path:
        return self._path

    async def __aenter__(self) -> WorkspaceLock:
        self.acquire()
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        self.release()

    def acquire(self) -> None:
        if self._handle is not None:
            raise RuntimeError(f"Workspace lock is already held: {self._agent_id}")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = self._path.open("a+b")
        try:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise WorkspaceBusyError(f"Workspace is busy: {self._agent_id}") from exc
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
