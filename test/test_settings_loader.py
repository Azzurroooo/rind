import json
import sys
from pathlib import Path
import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.providers import (
    load_providers,
    save_custom_provider,
)
from agent.infrastructure.llm.catalog import PROVIDERS
from agent.infrastructure.settings import (
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    build_default_user_agent,
    ensure_user_settings,
    load_settings,
    save_settings,
)
from agent.version import __version__


@pytest.fixture(autouse=True)
def ignore_inherited_rind_home(monkeypatch):
    monkeypatch.delenv("RIND_HOME", raising=False)


def write_settings(home: Path, data: dict) -> Path:
    path = home / ".rind" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_load_settings_reads_user_json(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = write_settings(
        tmp_path,
        {
            "provider": "openai",
            "model": "gpt-5.5",
            "reasoningEffort": "xhigh",
        },
    )

    settings = load_settings()

    assert settings.settings_path == path
    assert settings.settings_exists is True
    assert settings.provider == "openai"
    assert settings.model == "gpt-5.5"
    assert settings.reasoning_effort == "xhigh"


def test_load_settings_reads_server_token(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    write_settings(
        tmp_path,
        {
            "model": "gpt-5.5",
            "serverToken": " relay-secret ",
        },
    )

    settings = load_settings()

    assert settings.server_token == "relay-secret"


def test_load_settings_defaults_server_token_to_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    write_settings(tmp_path, {"model": "gpt-5.5"})

    settings = load_settings()

    assert settings.server_token == ""


def test_a_project_folder_never_supplies_settings(tmp_path, monkeypatch):
    """A cloned repository must not replace the user's global settings or server token."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    (tmp_path / "home").mkdir()
    user_path = write_settings(tmp_path / "home", {"provider": "deepseek", "model": "user-model"})
    project = tmp_path / "project" / ".rind" / "settings.json"
    project.parent.mkdir(parents=True)
    project.write_text(json.dumps({
        "provider": "openai", "model": "project-model", "serverToken": "known",
    }), encoding="utf-8")
    monkeypatch.chdir(project.parent.parent)

    settings = load_settings()

    assert settings.settings_path == user_path
    assert (settings.provider, settings.model, settings.server_token) == ("deepseek", "user-model", "")


def test_load_settings_ignores_legacy_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    write_settings(
        tmp_path,
        {
            "model": "gpt-5.5",
            "contextWindow": 128000,
            "autoCompactTokenLimitPercent": 90,
            "autoCompactEnabled": False,
        },
    )

    settings = load_settings()

    assert settings.model == "gpt-5.5"
    assert not hasattr(settings, "context_window")
    assert not hasattr(settings, "api_key")
    assert not hasattr(settings, "base_url")


def test_load_settings_uses_defaults_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    settings = load_settings()

    assert settings.settings_exists is False
    assert settings.settings_path == tmp_path / ".rind" / "settings.json"
    assert settings.provider == DEFAULT_PROVIDER
    assert settings.model == DEFAULT_MODEL
    assert settings.reasoning_effort == ""


def test_save_settings_updates_global_defaults_and_preserves_server_token(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = write_settings(tmp_path, {"provider": "openai", "model": "gpt-4o-mini", "serverToken": "keep-me"})

    updated = save_settings(provider="deepseek", model="deepseek-v4-pro", reasoning_effort="high")

    assert (updated.provider, updated.model, updated.reasoning_effort, updated.server_token) == (
        "deepseek", "deepseek-v4-pro", "high", "keep-me"
    )
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw == {
        "provider": "deepseek",
        "model": "deepseek-v4-pro",
        "reasoningEffort": "high",
        "serverToken": "keep-me",
    }


def test_providers_json_merges_builtin_overrides_and_custom_providers(tmp_path):
    providers_path = tmp_path / "providers.json"
    providers_path.write_text(json.dumps({
        "providers": {
            "deepseek": {
                "baseUrl": "https://proxy.deepseek.example/v1",
                "models": {
                    "deepseek-v4-pro": {"contextWindow": 512000},
                    "deepseek-custom": {"imageInput": True, "contextWindow": 64000, "reasoningEfforts": ["low", "high"]},
                },
            },
            "my-gateway": {
                "name": "My Gateway",
                "api": "openai-responses",
                "baseUrl": "https://gateway.example/v1",
                "envKey": "GATEWAY_API_KEY",
                "models": {
                    "gw-1": {"contextWindow": 200000, "imageInput": True, "reasoningEfforts": ["low", "medium", "high"]},
                    "gw-claude": {"api": "anthropic-messages", "contextWindow": 200000, "imageInput": True},
                },
            },
        }
    }), encoding="utf-8")

    merged, explicit = load_providers(providers_path, PROVIDERS)

    assert merged["deepseek"].default_base_url == "https://proxy.deepseek.example/v1"
    ds_models = {m.id: m for m in merged["deepseek"].fallback_models}
    assert ds_models["deepseek-v4-pro"].context_window == 512000
    assert ds_models["deepseek-custom"].image_input is True
    assert explicit["deepseek"]["deepseek-v4-pro"].context_window == 512000

    gw = merged["my-gateway"]
    assert (gw.name, gw.api, gw.default_base_url, gw.environment_key) == (
        "My Gateway", "openai-responses", "https://gateway.example/v1", "GATEWAY_API_KEY"
    )
    gw_models = {m.id: m for m in gw.fallback_models}
    assert gw_models["gw-1"].api == "openai-responses"
    assert gw_models["gw-claude"].api == "anthropic-messages"


def test_save_custom_provider_writes_providers_json(tmp_path):
    providers_path = tmp_path / "providers.json"
    save_custom_provider(
        "office-vllm",
        name="Office vLLM",
        api="openai-chat",
        base_url="https://vllm.internal/v1/",
        model="qwen3-coder",
        path=providers_path,
    )
    merged, _ = load_providers(providers_path, PROVIDERS)
    assert merged["office-vllm"].name == "Office vLLM"
    assert merged["office-vllm"].default_base_url == "https://vllm.internal/v1"
    assert [m.id for m in merged["office-vllm"].fallback_models] == ["qwen3-coder"]


@pytest.mark.parametrize("payload,match", [
    ({"providers": {"custom": {"api": "openai-chat"}}}, "baseUrl"),
    ({"providers": {"custom": {"baseUrl": "https://x.example/v1", "api": "bad-api"}}}, "Unsupported api"),
    ({"providers": {"deepseek": {"models": {"m": {"contextWindow": 0}}}}}, "contextWindow"),
    ({"providers": {"deepseek": {"models": {"m": {"imageInput": "yes"}}}}}, "imageInput"),
])
def test_invalid_providers_json_is_rejected(tmp_path, payload, match):
    providers_path = tmp_path / "providers.json"
    providers_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match=match):
        load_providers(providers_path, PROVIDERS)


def test_ensure_user_settings_creates_empty_default_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    path = ensure_user_settings()

    assert path == tmp_path / ".rind" / "settings.json"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "provider": DEFAULT_PROVIDER,
        "model": DEFAULT_MODEL,
        "reasoningEffort": "",
    }


def test_ensure_user_settings_never_overwrites_existing_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = write_settings(tmp_path, {"provider": "deepseek", "model": "existing-model"})

    ensure_user_settings()

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "provider": "deepseek",
        "model": "existing-model",
    }


def test_load_settings_ignores_environment_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("RIND_HOME", str(tmp_path / ".rind"))
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
    monkeypatch.setenv("OPENAI_API_BASE", "https://must-not-be-used.example/v1")
    monkeypatch.setenv("DEFAULT_MODEL", "must-not-be-used")
    monkeypatch.setenv("MODEL_REASONING_EFFORT", "must-not-be-used")
    path = write_settings(tmp_path, {})

    settings = load_settings()

    assert settings.settings_path == path
    assert settings.provider == DEFAULT_PROVIDER
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

