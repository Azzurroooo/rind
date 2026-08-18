"""Optional git status data used by the server command display."""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


_GIT_CACHE_TTL_SECONDS = 2.0


@dataclass(slots=True)
class GitPromptStatus:
    branch: str
    dirty: bool = False


class GitPromptStatusProvider:
    def __init__(self, cwd: str | Path | None = None, *, ttl_seconds: float = _GIT_CACHE_TTL_SECONDS):
        self._cwd = str(cwd or Path.cwd())
        self._ttl_seconds = ttl_seconds
        self._cached_at = 0.0
        self._cached_status: GitPromptStatus | None = None

    def current(self) -> GitPromptStatus | None:
        now = time.monotonic()
        if self._cached_at and now - self._cached_at < self._ttl_seconds:
            return self._cached_status
        self._cached_status = _read_git_status(self._cwd)
        self._cached_at = now
        return self._cached_status


def _read_git_status(cwd: str) -> GitPromptStatus | None:
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    if not branch:
        return None
    dirty_output = _run_git(["status", "--porcelain", "--untracked-files=no"], cwd)
    return GitPromptStatus(branch=branch, dirty=bool(dirty_output))


def _run_git(args: list[str], cwd: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=0.5,
            check=False,
        )
    except Exception:
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""
