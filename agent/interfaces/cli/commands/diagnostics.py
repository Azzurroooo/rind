"""Read-only CLI diagnostics for common setup problems."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from agent.interfaces.cli.formatting import tail_clip_text

from .router import SlashCommandContext


@dataclass(frozen=True, slots=True)
class DoctorCheck:
    status: str
    name: str
    detail: str


@dataclass(frozen=True, slots=True)
class DoctorReport:
    text: str
    failures: int
    warnings: int
    display: dict


@dataclass(frozen=True, slots=True)
class ConfigStatus:
    config: object | None
    error: str = ""


def render_doctor_report(context: SlashCommandContext) -> str:
    return build_doctor_report(context).text


def build_doctor_report(context: SlashCommandContext) -> DoctorReport:
    checks = _build_checks(context)
    failures = sum(1 for check in checks if check.status == "fail")
    warnings = sum(1 for check in checks if check.status == "warn")
    lines = ["Doctor:"]
    lines.extend(f"- [{check.status}] {check.name}: {check.detail}" for check in checks)
    lines.append(f"Overall: {failures} failure(s), {warnings} warning(s).")
    next_steps = _next_steps(checks)
    if next_steps:
        lines.append("Next steps:")
        lines.extend(f"- {step}" for step in next_steps)
    return DoctorReport(
        text="\n".join(lines),
        failures=failures,
        warnings=warnings,
        display={
            "type": "doctor",
            "checks": [
                {"status": check.status, "name": check.name, "detail": check.detail}
                for check in checks
            ],
            "failures": failures,
            "warnings": warnings,
            "next_steps": next_steps,
        },
    )


def _build_checks(context: SlashCommandContext) -> list[DoctorCheck]:
    config_status = _load_config_status()

    checks = [
        _python_check(),
        _working_directory_check(),
        _git_check(),
        _settings_check(config_status),
        _api_key_check(config_status),
        _model_check(config_status),
        _session_store_check(context),
        _shell_check(),
    ]
    return checks


def _load_config_status() -> ConfigStatus:
    try:
        from agent.infrastructure.config import Config

        return ConfigStatus(Config)
    except Exception as exc:
        return ConfigStatus(None, str(exc))


def _python_check() -> DoctorCheck:
    version = platform.python_version()
    if sys.version_info >= (3, 12):
        return DoctorCheck("ok", "Python", version)
    return DoctorCheck("fail", "Python", f"{version} (requires 3.12+)")


def _working_directory_check() -> DoctorCheck:
    cwd = Path.cwd()
    if cwd.exists() and cwd.is_dir():
        return DoctorCheck("ok", "Working directory", str(cwd))
    return DoctorCheck("fail", "Working directory", f"{cwd} is not available")


def _git_check() -> DoctorCheck:
    git = shutil.which("git")
    if not git:
        return DoctorCheck("warn", "Git", "not found on PATH")
    branch = _run_git(["branch", "--show-current"])
    if branch is None:
        return DoctorCheck("warn", "Git", "not a git worktree")
    dirty = _run_git(["status", "--short"])
    suffix = "clean" if not dirty else f"{len(dirty.splitlines())} change(s)"
    return DoctorCheck("ok", "Git", f"{branch or 'detached HEAD'} ({suffix})")


def _settings_check(status: ConfigStatus) -> DoctorCheck:
    if status.error:
        return DoctorCheck("fail", "Settings", f"{_settings_path_guess()} (invalid: {status.error})")
    config = status.config
    path = str(getattr(config, "SETTINGS_PATH", "") or "unknown")
    state = "found" if bool(getattr(config, "SETTINGS_EXISTS", False)) else "missing"
    severity = "ok" if state == "found" else "warn"
    return DoctorCheck(severity, "Settings", f"{path} ({state})")


def _api_key_check(status: ConfigStatus) -> DoctorCheck:
    config = status.config
    if not config:
        return DoctorCheck("warn", "API key", "not checked because settings are invalid")
    if getattr(config, "OPENAI_API_KEY", ""):
        return DoctorCheck("ok", "API key", "set")
    return DoctorCheck("fail", "API key", "unset")


def _model_check(status: ConfigStatus) -> DoctorCheck:
    config = status.config
    if not config:
        return DoctorCheck("warn", "Model", "not checked because settings are invalid")
    model = str(getattr(config, "DEFAULT_MODEL", "") or "").strip()
    if model:
        return DoctorCheck("ok", "Model", model)
    return DoctorCheck("fail", "Model", "unset")


def _session_store_check(context: SlashCommandContext) -> DoctorCheck:
    path = _session_root(context.session)
    if not path:
        return DoctorCheck("warn", "Session store", "unknown")
    writable_target = _nearest_existing_parent(path)
    if writable_target and os.access(str(writable_target), os.W_OK):
        state = "ready" if path.exists() else f"will create under {writable_target}"
        return DoctorCheck("ok", "Session store", f"{path} ({state})")
    return DoctorCheck("fail", "Session store", f"{path} is not writable")


def _shell_check() -> DoctorCheck:
    shell = os.environ.get("SHELL") or os.environ.get("ComSpec") or os.environ.get("PSModulePath")
    if shell:
        return DoctorCheck("ok", "Shell", tail_clip_text(shell, 90))
    return DoctorCheck("warn", "Shell", "not detected")


def _settings_path_guess() -> str:
    try:
        from agent.infrastructure.config.settings_loader import default_settings_path

        return str(default_settings_path())
    except Exception:
        return "settings.json"


def _session_root(session) -> Path | None:
    raw_root = getattr(session, "_session_root", None)
    if raw_root:
        return Path(str(raw_root)).expanduser()
    raw_dir = getattr(session, "_session_dir", None)
    try:
        from agent.infrastructure.persistence.async_jsonl_session_store import AsyncJsonlSessionStore

        return Path(AsyncJsonlSessionStore.resolve_session_root(str(raw_dir) if raw_dir else None))
    except Exception:
        return Path(str(raw_dir)).expanduser() if raw_dir else None


def _nearest_existing_parent(path: Path) -> Path | None:
    current = path
    while not current.exists():
        parent = current.parent
        if parent == current:
            return None
        current = parent
    return current


def _run_git(args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _next_steps(checks: list[DoctorCheck]) -> list[str]:
    steps = []
    names = {check.name: check for check in checks if check.status in {"fail", "warn"}}
    if "API key" in names:
        steps.append("Set apiKey in settings.json or export OPENAI_API_KEY.")
    settings_check = names.get("Settings")
    if settings_check and "invalid:" in settings_check.detail:
        steps.append("Fix settings.json syntax or replace it with the default template.")
    elif settings_check:
        steps.append("Run the CLI once to create the default settings template.")
    if "Session store" in names:
        steps.append("Choose a writable --session-dir or fix permissions for the session directory.")
    if "Python" in names:
        steps.append("Install Python 3.12 or newer.")
    return steps
