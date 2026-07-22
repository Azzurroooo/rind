"""Manages isolated shell sessions."""

from __future__ import annotations

import os
import platform
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


SHELL_UNAVAILABLE_MESSAGE = (
    "No supported shell backend was found. Install Git for Windows, set "
    "RIND_BASH_PATH to bash.exe, or enable PowerShell."
)


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
        self._default_executable, self._default_backend, self._default_error = self._detect_shell()

    def _detect_shell(self) -> tuple[str | None, str, str | None]:
        """Detect the available shell executable."""
        system = platform.system()
        if system == "Windows":
            configured = os.getenv("RIND_BASH_PATH", "").strip()
            if configured and Path(configured).is_file():
                return configured, self._backend_for_shell_path(Path(configured)), None
            for candidate in self._windows_bash_candidates():
                if candidate.is_file():
                    return str(candidate), self._backend_for_shell_path(candidate), None
            bash_path = shutil.which("bash")
            if bash_path:
                return bash_path, "bash", None
            powershell_path = self._detect_powershell()
            if powershell_path:
                return powershell_path, "powershell", None
            return None, "unavailable", SHELL_UNAVAILABLE_MESSAGE
        else:
            return shutil.which("bash") or "bash", "bash", None

    def _windows_bash_candidates(self) -> list[Path]:
        app_dir = Path(sys.executable).resolve().parent
        return [
            app_dir / "portable-git" / "bin" / "bash.exe",
            app_dir / "portable-git" / "usr" / "bin" / "bash.exe",
            app_dir / "portable-git" / "usr" / "bin" / "sh.exe",
            Path("C:/Program Files/Git/bin/bash.exe"),
            Path("C:/Program Files/Git/usr/bin/bash.exe"),
            Path("C:/Program Files/Git/usr/bin/sh.exe"),
        ]

    def _backend_for_shell_path(self, path: Path) -> str:
        return "sh" if path.name.lower() == "sh.exe" else "bash"

    def _detect_powershell(self) -> str | None:
        for name in ("pwsh", "powershell", "powershell.exe"):
            path = shutil.which(name)
            if path:
                return path
        candidate = Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
        return str(candidate) if candidate.is_file() else None

    def get_state(self, session_id: str) -> ShellState:
        """Get or create the shell state for a session."""
        if session_id not in self._states:
            self._states[session_id] = ShellState(
                cwd=os.getcwd(),
                env=os.environ.copy(),
                shell_executable=self._default_executable,
                shell_error=self._default_error,
                shell_backend=self._default_backend,
            )
        return self._states[session_id]

    def close(self, session_id: str) -> None:
        """Close a shell state if it exists."""
        self._states.pop(session_id, None)
