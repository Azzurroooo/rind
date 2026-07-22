import sys
import asyncio
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools.builtin.shell import session_pool as bash_session_pool
from agent.infrastructure.tools.builtin.shell.supervisor import ProcessSupervisor
from agent.infrastructure.tools.builtin.shell.session_pool import ShellSessionPool


def test_detect_shell_prefers_rind_bash_path(tmp_path, monkeypatch):
    bash_path = tmp_path / "bash.exe"
    bash_path.write_text("", encoding="utf-8")
    monkeypatch.setenv("RIND_BASH_PATH", str(bash_path))

    pool = ShellSessionPool()

    assert pool._default_executable == str(bash_path)
    assert pool._default_backend == "bash"


def test_detect_shell_uses_bundled_portable_git(tmp_path, monkeypatch):
    app_dir = tmp_path / "app"
    bash_path = app_dir / "portable-git" / "bin" / "bash.exe"
    bash_path.parent.mkdir(parents=True)
    bash_path.write_text("", encoding="utf-8")
    monkeypatch.delenv("RIND_BASH_PATH", raising=False)
    monkeypatch.setattr(bash_session_pool.platform, "system", lambda: "Windows")
    monkeypatch.setattr(bash_session_pool.sys, "executable", str(app_dir / "rind.exe"))
    monkeypatch.setattr(bash_session_pool.shutil, "which", lambda name: None)

    pool = ShellSessionPool()

    assert pool._default_executable == str(bash_path)
    assert pool._default_backend == "bash"


def test_detect_shell_uses_bundled_portable_git_usr_bin(tmp_path, monkeypatch):
    app_dir = tmp_path / "app"
    bash_path = app_dir / "portable-git" / "usr" / "bin" / "bash.exe"
    bash_path.parent.mkdir(parents=True)
    bash_path.write_text("", encoding="utf-8")
    monkeypatch.delenv("RIND_BASH_PATH", raising=False)
    monkeypatch.setattr(bash_session_pool.platform, "system", lambda: "Windows")
    monkeypatch.setattr(bash_session_pool.sys, "executable", str(app_dir / "rind.exe"))
    monkeypatch.setattr(bash_session_pool.shutil, "which", lambda name: None)

    pool = ShellSessionPool()

    assert pool._default_executable == str(bash_path)
    assert pool._default_backend == "bash"


def test_detect_shell_falls_back_to_powershell_on_windows(tmp_path, monkeypatch):
    powershell_path = tmp_path / "powershell.exe"
    powershell_path.write_text("", encoding="utf-8")
    monkeypatch.delenv("RIND_BASH_PATH", raising=False)
    monkeypatch.setattr(bash_session_pool.platform, "system", lambda: "Windows")
    monkeypatch.setattr(bash_session_pool.sys, "executable", str(tmp_path / "rind.exe"))
    monkeypatch.setattr(
        bash_session_pool.shutil,
        "which",
        lambda name: str(powershell_path) if name in {"pwsh", "powershell", "powershell.exe"} else None,
    )
    monkeypatch.setattr(
        ShellSessionPool,
        "_windows_bash_candidates",
        lambda self: [tmp_path / "missing" / "bash.exe"],
    )

    pool = ShellSessionPool()
    state = pool.get_state("fallback")

    assert state.shell_executable == str(powershell_path)
    assert state.shell_backend == "powershell"
    assert state.shell_error is None


def test_detect_shell_reports_missing_backend_on_windows(tmp_path, monkeypatch):
    monkeypatch.delenv("RIND_BASH_PATH", raising=False)
    monkeypatch.setattr(bash_session_pool.platform, "system", lambda: "Windows")
    monkeypatch.setattr(bash_session_pool.sys, "executable", str(tmp_path / "rind.exe"))
    monkeypatch.setattr(bash_session_pool.shutil, "which", lambda name: None)
    monkeypatch.setattr(
        ShellSessionPool,
        "_windows_bash_candidates",
        lambda self: [tmp_path / "missing" / "bash.exe"],
    )
    monkeypatch.setattr(ShellSessionPool, "_detect_powershell", lambda self: None)

    pool = ShellSessionPool()
    state = pool.get_state("missing")

    assert state.shell_executable is None
    assert state.shell_backend == "unavailable"
    assert "No supported shell backend" in (state.shell_error or "")


def test_process_supervisor_builds_powershell_command(tmp_path):
    state = bash_session_pool.ShellState(
        cwd=str(tmp_path),
        env={},
        shell_executable=r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        shell_backend="powershell",
    )
    command = ProcessSupervisor(timeout=1)._build_shell_cmd("Write-Output hello", state)

    assert command[0].endswith("powershell.exe")
    assert "-Command" in command
    assert command[-1] == "Write-Output hello"


def test_process_supervisor_returns_clear_error_when_shell_missing(tmp_path):
    state = bash_session_pool.ShellState(
        cwd=str(tmp_path),
        env={},
        shell_executable=None,
        shell_error="No supported shell backend was found.",
        shell_backend="unavailable",
    )
    result = asyncio.run(ProcessSupervisor(timeout=1).run("echo hello", state, "test"))

    assert result.status == "error"
    assert result.error_type == "RuntimeError"
    assert "No supported shell backend" in result.error_msg


class _EmptyStream:
    async def read(self, _size):
        return b""


class _CompletedProcess:
    pid = 123
    stdout = _EmptyStream()
    stderr = _EmptyStream()
    returncode = 0

    async def wait(self):
        return 0

    def kill(self):
        return None


def test_process_supervisor_detaches_child_stdin(tmp_path, monkeypatch):
    calls = []

    async def fake_create_subprocess_exec(*_args, **kwargs):
        calls.append(kwargs)
        return _CompletedProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    state = bash_session_pool.ShellState(
        cwd=str(tmp_path),
        env={},
        shell_executable="bash",
    )
    supervisor = ProcessSupervisor(timeout=1)

    async def run():
        await supervisor.run("echo hello", state, "session_1")
        bg = await supervisor._spawn("echo hello", state, "session_1", True)
        await bg.finished.wait()

    asyncio.run(run())

    assert calls
    assert all(call.get("stdin") is asyncio.subprocess.DEVNULL for call in calls)
