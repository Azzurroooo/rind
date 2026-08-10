import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _shared_settings_path(home: Path) -> Path:
    return home / ".rind" / "settings.json"


def _subprocess_env(home: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    return env


def test_resume_mode_flag_is_removed() -> None:
    result = subprocess.run(
        [sys.executable, "main.py", "--resume-mode", "summary"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )

    if result.returncode == 0:
        raise AssertionError("Expected main.py to reject the removed --resume-mode flag.")
    combined = f"{result.stdout}\n{result.stderr}"
    if "unrecognized arguments: --resume-mode summary" not in combined:
        raise AssertionError(f"Expected argparse unknown-flag error, got: {combined}")


def test_agent_flag_is_a_strict_cwd_assertion() -> None:
    result = subprocess.run(
        [sys.executable, "main.py", "--agent", "main-agent"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )

    if result.returncode == 0:
        raise AssertionError("Expected --agent to reject a non-Agent current directory.")
    combined = f"{result.stdout}\n{result.stderr}"
    if "--agent requires the current directory to be a valid Agent workspace." not in combined:
        raise AssertionError(f"Expected strict Agent workspace error, got: {combined}")

    import main as main_module

    with patch("agent.infrastructure.team.discover_agent", return_value=SimpleNamespace(agent_id="main-agent")):
        main_module._validate_agent_assertion("main-agent")

    with patch("agent.infrastructure.team.discover_agent", return_value=SimpleNamespace(agent_id="other")):
        try:
            main_module._validate_agent_assertion("main-agent")
        except ValueError as exc:
            if "does not match the current Agent" not in str(exc):
                raise AssertionError(f"Expected mismatch error, got: {exc}") from exc
        else:
            raise AssertionError("Expected --agent to reject an identity mismatch.")


def test_agent_flag_accepts_only_the_current_capsule(tmp_path, monkeypatch) -> None:
    from agent.infrastructure.team import initialize_team_project
    import main as main_module

    initialize_team_project(tmp_path, project_id="quant-project")
    monkeypatch.chdir(tmp_path / "agents" / "main-agent")

    main_module._validate_agent_assertion("main-agent")

    try:
        main_module._validate_agent_assertion("other")
    except ValueError as exc:
        if "does not match the current Agent" not in str(exc):
            raise AssertionError(f"Expected mismatch error, got: {exc}") from exc
    else:
        raise AssertionError("Expected --agent to reject a different Capsule id.")


def test_version_does_not_validate_config(tmp_path) -> None:
    bad_settings = _shared_settings_path(tmp_path)
    bad_settings.parent.mkdir()
    bad_settings.write_text("{", encoding="utf-8")
    env = _subprocess_env(tmp_path)

    result = subprocess.run(
        [sys.executable, "main.py", "--version"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise AssertionError(f"Expected --version to succeed, got: {result.stderr}")
    if "rind " not in result.stdout:
        raise AssertionError(f"Expected version output, got: {result.stdout}")


def test_doctor_runs_without_api_key(tmp_path) -> None:
    env = _subprocess_env(tmp_path)

    result = subprocess.run(
        [sys.executable, "main.py", "--doctor"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    if result.returncode != 1:
        raise AssertionError(f"Expected --doctor to report setup failure, got: {result.returncode}")
    if "Doctor:" not in result.stdout:
        raise AssertionError(f"Expected doctor report, got: {result.stdout}")
    if "API key: unset" not in result.stdout:
        raise AssertionError(f"Expected API key diagnostic, got: {result.stdout}")
    if "Configuration error:" in result.stderr:
        raise AssertionError(f"Expected --doctor to avoid startup validation, got: {result.stderr}")


def test_doctor_reports_invalid_settings_json(tmp_path) -> None:
    bad_settings = _shared_settings_path(tmp_path)
    bad_settings.parent.mkdir()
    bad_settings.write_text("{", encoding="utf-8")
    env = _subprocess_env(tmp_path)

    result = subprocess.run(
        [sys.executable, "main.py", "--doctor"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    if result.returncode != 1:
        raise AssertionError(f"Expected --doctor to report invalid settings, got: {result.returncode}")
    if "Settings:" not in result.stdout or "invalid" not in result.stdout:
        raise AssertionError(f"Expected invalid settings diagnostic, got: {result.stdout}")
    if "Fix settings.json syntax" not in result.stdout:
        raise AssertionError(f"Expected repair guidance, got: {result.stdout}")
    if "Traceback" in result.stderr:
        raise AssertionError(f"Expected friendly diagnostics, got: {result.stderr}")


def test_session_rejects_invalid_id_before_config_validation(tmp_path) -> None:
    bad_settings = _shared_settings_path(tmp_path)
    bad_settings.parent.mkdir()
    bad_settings.write_text("{", encoding="utf-8")
    env = _subprocess_env(tmp_path)

    result = subprocess.run(
        [sys.executable, "main.py", "--session", "../escape"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    if result.returncode != 1:
        raise AssertionError(f"Expected invalid session id to fail, got: {result.returncode}")
    if "Session error: Invalid session id." not in result.stderr:
        raise AssertionError(f"Expected session validation error, got: {result.stderr}")
    if "Configuration error:" in result.stderr:
        raise AssertionError(f"Expected session validation before config validation, got: {result.stderr}")


def test_session_rejects_empty_id_before_startup() -> None:
    result = subprocess.run(
        [sys.executable, "main.py", "--session", ""],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )

    if result.returncode != 1:
        raise AssertionError(f"Expected empty session id to fail, got: {result.returncode}")
    if "Session error: Invalid session id." not in result.stderr:
        raise AssertionError(f"Expected session validation error, got: {result.stderr}")


def test_main_returns_130_on_keyboard_interrupt() -> None:
    import main as main_module

    class InterruptingCli:
        def start(self):
            raise KeyboardInterrupt

    with (
        patch.object(sys, "argv", ["main.py"]),
        patch("agent.infrastructure.config.Config.ensure_user_settings_template"),
        patch("agent.infrastructure.config.Config.reload"),
        patch("agent.infrastructure.config.validate_settings"),
        patch(
            "agent.bootstrap.build_agent_container",
            return_value=SimpleNamespace(runtime=object(), session_store=object()),
        ),
        patch("agent.interfaces.cli.ChatCLI", return_value=InterruptingCli()),
    ):
        result = main_module.main()

    if result != 130:
        raise AssertionError(f"Expected Ctrl+C exit code 130, got: {result}")


def main() -> int:
    test_resume_mode_flag_is_removed()
    test_agent_flag_is_a_strict_cwd_assertion()
    with tempfile.TemporaryDirectory() as temp_dir:
        test_version_does_not_validate_config(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_doctor_runs_without_api_key(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_doctor_reports_invalid_settings_json(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_session_rejects_invalid_id_before_config_validation(Path(temp_dir))
    test_session_rejects_empty_id_before_startup()
    test_main_returns_130_on_keyboard_interrupt()
    print("Main CLI arg tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
