import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.infrastructure.config.settings_loader import AppSettings
from agent.infrastructure.llm import OpenAIClientFactory


def _settings(tmp_path: Path, *, user_agent: str = "test-agent") -> AppSettings:
    return AppSettings(
        settings_path=tmp_path / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent=user_agent,
    )


def test_create_client_passes_settings_and_user_agent(tmp_path):
    with patch("agent.infrastructure.llm.client_factory.OpenAI") as mock_openai:
        OpenAIClientFactory(_settings(tmp_path)).create_client()

    assert mock_openai.call_args.kwargs["api_key"] == "test-key"
    assert mock_openai.call_args.kwargs["base_url"] == "https://example.com/v1"
    assert mock_openai.call_args.kwargs["default_headers"] == {"User-Agent": "test-agent"}


def test_create_async_client_omits_empty_user_agent(tmp_path):
    with patch("agent.infrastructure.llm.client_factory.AsyncOpenAI") as mock_async_openai:
        OpenAIClientFactory(_settings(tmp_path, user_agent="")).create_async_client()

    assert mock_async_openai.call_args.kwargs["default_headers"] is None
