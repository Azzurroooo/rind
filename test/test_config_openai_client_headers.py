import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.infrastructure.config.settings import Config


def test_get_client_passes_default_user_agent(monkeypatch):
    with patch("agent.infrastructure.config.settings.OpenAI") as mock_openai:
        monkeypatch.setattr(Config, "OPENAI_USER_AGENT", "test-agent")

        Config.get_client()

    assert mock_openai.call_args.kwargs["default_headers"] == {"User-Agent": "test-agent"}


def test_get_async_client_omits_empty_user_agent(monkeypatch):
    with patch("agent.infrastructure.config.settings.AsyncOpenAI") as mock_async_openai:
        monkeypatch.setattr(Config, "OPENAI_USER_AGENT", "")

        Config.get_async_client()

    assert mock_async_openai.call_args.kwargs["default_headers"] is None
