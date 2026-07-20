import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.config.settings_loader import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_SETTINGS_TEMPLATE,
    build_default_user_agent,
    ensure_user_settings_template,
    load_settings,
    save_settings_patch,
)


def test_load_settings_reads_user_json(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "model": "gpt-5.5",
                "apiKey": "secret-key",
                "baseUrl": "https://openai945.cn/",
                "reasoningEffort": "xhigh",
            }
        ),
        encoding="utf-8",
    )

    settings = load_settings(path)

    assert settings.settings_path == path
    assert settings.settings_exists is True
    assert settings.model == "gpt-5.5"
    assert settings.api_key == "secret-key"
    assert settings.base_url == "https://openai945.cn/"
    assert settings.reasoning_effort == "xhigh"


def test_load_settings_ignores_legacy_internal_budget_fields(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "model": "gpt-5.5",
                "apiKey": "secret-key",
                "baseUrl": "https://openai945.cn/",
                "reasoningEffort": "xhigh",
                "contextWindow": 128000,
                "autoCompactTokenLimitPercent": 90,
                "autoCompactEnabled": False,
            }
        ),
        encoding="utf-8",
    )

    settings = load_settings(path)

    assert settings.model == "gpt-5.5"
    assert not hasattr(settings, "context_window")
    assert not hasattr(settings, "auto_compact_token_limit_percent")
    assert not hasattr(settings, "auto_compact_enabled")


def test_load_settings_falls_back_to_env_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    monkeypatch.setenv("OPENAI_API_BASE", "https://env-base/v1")
    monkeypatch.setenv("DEFAULT_MODEL", "env-model")
    monkeypatch.setenv("MODEL_REASONING_EFFORT", "high")

    settings = load_settings(tmp_path / "missing.json")

    assert settings.settings_exists is False
    assert settings.model == "env-model"
    assert settings.api_key == "env-key"
    assert settings.base_url == "https://env-base/v1"
    assert settings.reasoning_effort == "high"


def test_load_settings_uses_env_path_override(tmp_path, monkeypatch):
    path = tmp_path / "tangerine-settings.json"
    path.write_text(json.dumps({"apiKey": "path-key"}), encoding="utf-8")
    monkeypatch.setenv("TANGERINE_SETTINGS_PATH", str(path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    settings = load_settings()

    assert settings.settings_path == path
    assert settings.api_key == "path-key"
    assert settings.model == DEFAULT_MODEL
    assert settings.base_url == DEFAULT_BASE_URL


def test_load_settings_empty_reasoning_effort_does_not_fallback_to_env(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"apiKey": "key", "reasoningEffort": ""}), encoding="utf-8")
    monkeypatch.setenv("MODEL_REASONING_EFFORT", "xhigh")

    settings = load_settings(path)

    assert settings.reasoning_effort == ""


def test_ensure_user_settings_template_creates_neutral_template(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("TANGERINE_SETTINGS_PATH", raising=False)
    monkeypatch.delenv("TANGERINE_HOME", raising=False)

    path = ensure_user_settings_template()

    assert path == tmp_path / ".tangerine" / "settings.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert set(data) == set(DEFAULT_SETTINGS_TEMPLATE) == {"model", "apiKey", "baseUrl", "reasoningEffort"}
    assert data["apiKey"] == ""
    assert data["baseUrl"] == ""
    assert data["reasoningEffort"] == "xhigh"


def test_default_settings_path_uses_tangerine_home(tmp_path, monkeypatch):
    tangerine_home = tmp_path / "portable-home"
    monkeypatch.setenv("TANGERINE_HOME", str(tangerine_home))
    monkeypatch.delenv("TANGERINE_SETTINGS_PATH", raising=False)

    path = ensure_user_settings_template()

    assert path == tangerine_home / "settings.json"
    assert path.exists()


def test_ensure_user_settings_template_skips_custom_settings_path(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGERINE_SETTINGS_PATH", str(tmp_path / "custom.json"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert ensure_user_settings_template() is None
    assert not (tmp_path / ".tangerine").exists()


def test_save_settings_patch_preserves_existing_values(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "model": "old-model",
                "apiKey": "secret-key",
                "baseUrl": "https://example.com/v1",
            }
        ),
        encoding="utf-8",
    )

    settings = save_settings_patch({"model": "new-model"}, path)
    data = json.loads(path.read_text(encoding="utf-8"))

    assert settings.model == "new-model"
    assert data["model"] == "new-model"
    assert data["apiKey"] == "secret-key"
    assert data["baseUrl"] == "https://example.com/v1"


def test_save_settings_patch_creates_missing_settings_file(tmp_path):
    path = tmp_path / "nested" / "settings.json"

    settings = save_settings_patch({"model": "new-model"}, path)
    data = json.loads(path.read_text(encoding="utf-8"))

    assert settings.settings_exists is True
    assert settings.model == "new-model"
    assert set(data) == set(DEFAULT_SETTINGS_TEMPLATE)
    assert data["model"] == "new-model"
    assert "apiKey" in data


def test_build_default_user_agent_uses_windows_terminal(monkeypatch):
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.system", lambda: "Windows")
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.release", lambda: "11")
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.machine", lambda: "AMD64")
    monkeypatch.setenv("WT_SESSION", "session")
    monkeypatch.delenv("TERM_PROGRAM", raising=False)
    monkeypatch.delenv("TERM", raising=False)

    assert build_default_user_agent() == "tangerine/0.2.0 (Windows 11; AMD64) WindowsTerminal"


def test_build_default_user_agent_uses_term_program_version(monkeypatch):
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.system", lambda: "Darwin")
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.release", lambda: "25.0.0")
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.machine", lambda: "arm64")
    monkeypatch.delenv("WT_SESSION", raising=False)
    monkeypatch.setenv("TERM_PROGRAM", "vscode")
    monkeypatch.setenv("TERM_PROGRAM_VERSION", "1.99.0")
    monkeypatch.setenv("TERM", "xterm-256color")

    assert build_default_user_agent() == "tangerine/0.2.0 (Darwin 25.0.0; arm64) vscode/1.99.0"


def test_build_default_user_agent_sanitizes_terminal_token(monkeypatch):
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.system", lambda: "Linux")
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.release", lambda: "6.1")
    monkeypatch.setattr("agent.infrastructure.config.settings_loader.platform.machine", lambda: "x86_64")
    monkeypatch.delenv("WT_SESSION", raising=False)
    monkeypatch.setenv("TERM_PROGRAM", "bad\rname")
    monkeypatch.setenv("TERM_PROGRAM_VERSION", "1 2")

    assert build_default_user_agent() == "tangerine/0.2.0 (Linux 6.1; x86_64) bad_name/1_2"
