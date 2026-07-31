import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.config.settings import Config
from agent.infrastructure.llm import OpenAIClientFactory


@pytest.fixture(autouse=True)
def restore_config():
    tracked_names = (
        "SETTINGS",
        "SETTINGS_PATH",
        "SETTINGS_EXISTS",
        "OPENAI_API_KEY",
        "OPENAI_API_BASE",
        "OPENAI_USER_AGENT",
        "DEFAULT_MODEL",
        "MODEL_REASONING_EFFORT",
    )
    attrs = {name: getattr(Config, name) for name in tracked_names if hasattr(Config, name)}
    yield
    for key, value in attrs.items():
        setattr(Config, key, value)


def test_config_reload_reads_settings_json(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "model": "gpt-5.5",
                "apiKey": "settings-key",
                "baseUrl": "https://openai945.cn/",
                "reasoningEffort": "xhigh",
                "contextWindow": 128000,
                "autoCompactTokenLimitPercent": 90,
                "autoCompactEnabled": False,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))

    Config.reload()

    assert Config.SETTINGS_PATH == str(path)
    assert Config.SETTINGS_EXISTS is True
    assert Config.OPENAI_API_KEY == "settings-key"
    assert Config.OPENAI_API_BASE == "https://openai945.cn/"
    assert Config.DEFAULT_MODEL == "gpt-5.5"
    assert Config.MODEL_REASONING_EFFORT == "xhigh"


def test_config_does_not_expose_internal_budget_settings(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "model": "gpt-5.5",
                "apiKey": "settings-key",
                "contextWindow": 128000,
                "autoCompactTokenLimitPercent": 90,
                "autoCompactEnabled": False,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))

    Config.reload()

    assert not hasattr(Config, "CONTEXT_WINDOW_TOKENS")
    assert not hasattr(Config, "AUTO_COMPACT_TOKEN_LIMIT_PERCENT")
    assert not hasattr(Config, "AUTO_COMPACT_ENABLED")


def test_config_validate_reports_settings_path_when_api_key_missing(tmp_path, monkeypatch):
    path = tmp_path / "missing.json"
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    Config.reload()

    with pytest.raises(ValueError) as exc:
        Config.validate()

    assert str(path) in str(exc.value)
    assert "apiKey" in str(exc.value)


def test_openai_client_factory_uses_loaded_settings(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"apiKey": "settings-key", "baseUrl": "https://example.com/v1"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))
    settings = Config.reload()

    with patch("agent.infrastructure.llm.client_factory.AsyncOpenAI") as mock_async_openai:
        OpenAIClientFactory(settings).create_async_client()

    kwargs = mock_async_openai.call_args.kwargs
    assert kwargs["api_key"] == "settings-key"
    assert kwargs["base_url"] == "https://example.com/v1"
    user_agent = kwargs["default_headers"]["User-Agent"]
    assert user_agent.startswith("rind/0.3.0 (")
    assert "; " in user_agent
    assert ") " in user_agent


def test_config_set_model_updates_settings_json(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"model": "old-model", "apiKey": "settings-key"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))
    Config.reload()

    settings = Config.set_model("new-model")
    data = json.loads(path.read_text(encoding="utf-8"))

    assert settings.model == "new-model"
    assert Config.DEFAULT_MODEL == "new-model"
    assert data["model"] == "new-model"
    assert data["apiKey"] == "settings-key"


def test_config_set_model_rejects_empty_model(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model": "old-model"}), encoding="utf-8")
    monkeypatch.setenv("RIND_SETTINGS_PATH", str(path))
    Config.reload()

    with pytest.raises(ValueError, match="Model name"):
        Config.set_model(" ")

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["model"] == "old-model"
