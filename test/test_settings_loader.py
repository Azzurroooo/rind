import json
import sys
from pathlib import Path
import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.settings import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    build_default_user_agent,
    ensure_user_settings,
    load_settings,
)
from agent.version import __version__


@pytest.fixture(autouse=True)
def ignore_inherited_rind_home(monkeypatch):
    monkeypatch.delenv("RIND_HOME", raising=False)


def write_settings(home: Path, data: dict) -> Path:
    path = home / ".rind" / "settings.json"
    path.parent.mkdir()
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_load_settings_reads_user_json(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = write_settings(
        tmp_path,
        {
            "model": "gpt-5.5",
            "apiKey": "secret-key",
            "baseUrl": "https://openai945.cn/",
            "reasoningEffort": "xhigh",
        },
    )

    settings = load_settings()

    assert settings.settings_path == path
    assert settings.settings_exists is True
    assert settings.model == "gpt-5.5"
    assert settings.api_key == "secret-key"
    assert settings.base_url == "https://openai945.cn/"
    assert settings.reasoning_effort == "xhigh"


def test_load_settings_reads_server_token(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    write_settings(
        tmp_path,
        {
            "model": "gpt-5.5",
            "apiKey": "secret-key",
            "baseUrl": "https://openai945.cn/",
            "serverToken": " relay-secret ",
        },
    )

    settings = load_settings()

    assert settings.server_token == "relay-secret"


def test_load_settings_defaults_server_token_to_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    write_settings(tmp_path, {"model": "gpt-5.5", "apiKey": "secret-key"})

    settings = load_settings()

    assert settings.server_token == ""


def test_a_project_folder_never_supplies_settings(tmp_path, monkeypatch):
    """A cloned repository must not redirect the user's key or replace the server token."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    (tmp_path / "home").mkdir()
    user_path = write_settings(tmp_path / "home", {"provider": "deepseek", "model": "user-model"})
    project = tmp_path / "project" / ".rind" / "settings.json"
    project.parent.mkdir(parents=True)
    project.write_text(json.dumps({
        "provider": "deepseek", "model": "project-model", "baseUrl": "https://attacker.example/v1",
        "apiKey": "project-key", "serverToken": "known",
    }), encoding="utf-8")
    monkeypatch.chdir(project.parent.parent)

    settings = load_settings()

    assert settings.settings_path == user_path
    assert (settings.model, settings.base_url, settings.api_key, settings.server_token) == (
        "user-model", DEFAULT_BASE_URL, "", "")


def test_load_settings_ignores_legacy_internal_budget_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    write_settings(
        tmp_path,
        {
            "model": "gpt-5.5",
            "apiKey": "secret-key",
            "contextWindow": 128000,
            "autoCompactTokenLimitPercent": 90,
            "autoCompactEnabled": False,
        },
    )

    settings = load_settings()

    assert settings.model == "gpt-5.5"
    assert not hasattr(settings, "context_window")
    assert not hasattr(settings, "auto_compact_token_limit_percent")
    assert not hasattr(settings, "auto_compact_enabled")


def test_load_settings_uses_defaults_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    settings = load_settings()

    assert settings.settings_exists is False
    assert settings.settings_path == tmp_path / ".rind" / "settings.json"
    assert settings.model == DEFAULT_MODEL
    assert settings.api_key == ""
    assert settings.base_url == DEFAULT_BASE_URL
    assert settings.reasoning_effort == ""


def test_ensure_user_settings_creates_empty_default_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    path = ensure_user_settings()

    assert path == tmp_path / ".rind" / "settings.json"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "provider": "openai-compatible",
        "api": "openai-chat",
        "baseUrl": DEFAULT_BASE_URL,
        "apiKey": "",
        "model": DEFAULT_MODEL,
        "reasoningEffort": "",
    }


def test_ensure_user_settings_never_overwrites_existing_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = write_settings(tmp_path, {"apiKey": "existing-secret", "model": "existing-model"})

    ensure_user_settings()

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "apiKey": "existing-secret",
        "model": "existing-model",
    }


def test_load_settings_ignores_environment_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("RIND_HOME", str(tmp_path / ".rind"))
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
    monkeypatch.setenv("OPENAI_API_BASE", "https://must-not-be-used.example/v1")
    monkeypatch.setenv("DEFAULT_MODEL", "must-not-be-used")
    monkeypatch.setenv("MODEL_REASONING_EFFORT", "must-not-be-used")
    path = write_settings(tmp_path, {"apiKey": ""})

    settings = load_settings()

    assert settings.settings_path == path
    assert settings.api_key == ""
    assert settings.base_url == DEFAULT_BASE_URL
    assert settings.model == DEFAULT_MODEL
    assert settings.reasoning_effort == ""


def test_build_default_user_agent_uses_windows_terminal(monkeypatch):
    monkeypatch.setattr("agent.infrastructure.settings.platform.system", lambda: "Windows")
    monkeypatch.setattr("agent.infrastructure.settings.platform.release", lambda: "11")
    monkeypatch.setattr("agent.infrastructure.settings.platform.machine", lambda: "AMD64")
    monkeypatch.setenv("WT_SESSION", "session")
    monkeypatch.delenv("TERM_PROGRAM", raising=False)
    monkeypatch.delenv("TERM", raising=False)

    assert build_default_user_agent() == f"rind/{__version__} (Windows 11; AMD64) WindowsTerminal"


def test_build_default_user_agent_uses_term_program_version(monkeypatch):
    monkeypatch.setattr("agent.infrastructure.settings.platform.system", lambda: "Darwin")
    monkeypatch.setattr("agent.infrastructure.settings.platform.release", lambda: "25.0.0")
    monkeypatch.setattr("agent.infrastructure.settings.platform.machine", lambda: "arm64")
    monkeypatch.delenv("WT_SESSION", raising=False)
    monkeypatch.setenv("TERM_PROGRAM", "vscode")
    monkeypatch.setenv("TERM_PROGRAM_VERSION", "1.99.0")
    monkeypatch.setenv("TERM", "xterm-256color")

    assert build_default_user_agent() == f"rind/{__version__} (Darwin 25.0.0; arm64) vscode/1.99.0"


def test_build_default_user_agent_sanitizes_terminal_token(monkeypatch):
    monkeypatch.setattr("agent.infrastructure.settings.platform.system", lambda: "Linux")
    monkeypatch.setattr("agent.infrastructure.settings.platform.release", lambda: "6.1")
    monkeypatch.setattr("agent.infrastructure.settings.platform.machine", lambda: "x86_64")
    monkeypatch.delenv("WT_SESSION", raising=False)
    monkeypatch.setenv("TERM_PROGRAM", "bad\rname")
    monkeypatch.setenv("TERM_PROGRAM_VERSION", "1 2")

    assert build_default_user_agent() == f"rind/{__version__} (Linux 6.1; x86_64) bad_name/1_2"
