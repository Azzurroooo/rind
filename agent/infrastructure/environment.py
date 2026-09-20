"""Host environment and shell discovery for prompts and execution."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import os
from pathlib import Path
import platform
import shutil
import sys


SHELL_UNAVAILABLE_MESSAGE = (
    "No supported shell backend was found. Install Git for Windows, set "
    "RIND_BASH_PATH to bash.exe, or enable PowerShell."
)


@dataclass(frozen=True, slots=True)
class ShellDetection:
    executable: str | None
    backend: str
    error: str | None = None


def detect_default_shell() -> ShellDetection:
    """Detect the host's default shell executable and backend kind."""
    if platform.system() != "Windows":
        return ShellDetection(shutil.which("bash") or "bash", "bash")

    configured = os.getenv("RIND_BASH_PATH", "").strip()
    if configured and Path(configured).is_file():
        return _from_path(Path(configured))
    for candidate in _windows_bash_candidates():
        if candidate.is_file():
            return _from_path(candidate)
    bash_path = shutil.which("bash")
    if bash_path:
        return ShellDetection(bash_path, "bash")
    powershell_path = _detect_powershell()
    if powershell_path:
        return ShellDetection(powershell_path, "powershell")
    return ShellDetection(None, "unavailable", SHELL_UNAVAILABLE_MESSAGE)


def _from_path(path: Path) -> ShellDetection:
    return ShellDetection(str(path), "sh" if path.name.lower() == "sh.exe" else "bash")


def _windows_bash_candidates() -> list[Path]:
    app_dir = Path(sys.executable).resolve().parent
    return [
        app_dir / "portable-git" / "bin" / "bash.exe",
        app_dir / "portable-git" / "usr" / "bin" / "bash.exe",
        app_dir / "portable-git" / "usr" / "bin" / "sh.exe",
        Path("C:/Program Files/Git/bin/bash.exe"),
        Path("C:/Program Files/Git/usr/bin/bash.exe"),
        Path("C:/Program Files/Git/usr/bin/sh.exe"),
    ]


def _detect_powershell() -> str | None:
    for name in ("pwsh", "powershell", "powershell.exe"):
        path = shutil.which(name)
        if path:
            return path
    candidate = Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    return str(candidate) if candidate.is_file() else None


def _detect_shell_display() -> tuple[str, str]:
    detection = detect_default_shell()
    shell_type = {
        "bash": "Bash",
        "sh": "POSIX sh",
        "powershell": "PowerShell",
        "unavailable": "Unavailable",
    }.get(detection.backend, detection.backend)
    return shell_type, detection.executable or "not found"


def get_system_info(cwd: str | os.PathLike[str] | None = None):
    """Collect dynamic system information."""
    system = platform.system()
    cwd = os.path.abspath(os.fspath(cwd)) if cwd is not None else os.getcwd()
    current_date = date.today().isoformat()
    shell_type, shell_executable = _detect_shell_display()

    return f"""
<environment_context>
Operating System: {system}
Current Date: {current_date}
Current Working Directory (Project Root): {cwd}
Shell Type: {shell_type}
Shell Executable: {shell_executable}
</environment_context>
"""
