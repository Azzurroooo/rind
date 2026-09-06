"""Manages isolated shell sessions."""

from __future__ import annotations

import os
from dataclasses import dataclass

from agent.domain.shell import detect_default_shell


@dataclass
class ShellState:
    """State for a single isolated shell session."""
    cwd: str
    env: dict[str, str]
    shell_executable: str | None
    shell_error: str | None = None
    shell_backend: str = "bash"


class ShellSessionPool:
    """Manages isolated shell states per session."""

    def __init__(self):
        self._states: dict[str, ShellState] = {}
        self._default = detect_default_shell()

    def get_state(self, session_id: str, workspace_root: str | None = None) -> ShellState:
        """Get or create the shell state for a session."""
        if session_id not in self._states:
            self._states[session_id] = ShellState(
                cwd=os.path.abspath(os.path.expanduser(workspace_root or os.getcwd())),
                env=os.environ.copy(),
                shell_executable=self._default.executable,
                shell_error=self._default.error,
                shell_backend=self._default.backend,
            )
        return self._states[session_id]

    def close(self, session_id: str) -> None:
        """Close a shell state if it exists."""
        self._states.pop(session_id, None)
