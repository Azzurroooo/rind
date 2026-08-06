"""Production composition-root tests."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.bootstrap import AgentContainer, build_agent_container
from agent.infrastructure.config import AppSettings
from agent.infrastructure.team import initialize_team_project


class FakeProviderClientFactory:
    def __init__(self) -> None:
        self.client = object()

    def create_async_client(self):
        return self.client


def test_container_explicitly_shares_production_dependencies() -> None:
    cache_dir = PROJECT_ROOT / ".pytest_cache"
    cache_dir.mkdir(exist_ok=True)
    settings = AppSettings(
        settings_path=cache_dir / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )
    provider_client_factory = FakeProviderClientFactory()

    with tempfile.TemporaryDirectory(dir=cache_dir) as session_dir:
        container = build_agent_container(
            settings=settings,
            provider_client_factory=provider_client_factory,
            session_dir=session_dir,
        )

        assert isinstance(container, AgentContainer)
        assert container.settings is settings
        assert container.provider_client_factory is provider_client_factory
        assert container.chat_client._client is provider_client_factory.client
        assert container.chat_client.model == "test-model"
        assert container.runtime._turn_runner is container.turn_runner
        assert container.runtime._session_store is container.session_store
        assert container.turn_runner._tool_processor is container.tool_processor
        assert container.turn_runner._context_manager is container.context_manager
        assert container.turn_runner._compaction_service is container.compaction_service
        assert container.tool_processor._tool_executor is container.tool_executor
        assert container.tool_processor._tool_result_normalizer is container.tool_result_normalizer
        assert container.context_manager._estimator is container.context_estimator
        assert not hasattr(container, "cli")


def test_container_filters_tools_before_building_registry_and_schema() -> None:
    cache_dir = PROJECT_ROOT / ".pytest_cache"
    cache_dir.mkdir(exist_ok=True)
    settings = AppSettings(
        settings_path=cache_dir / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )

    with tempfile.TemporaryDirectory(dir=cache_dir) as session_dir:
        container = build_agent_container(
            settings=settings,
            provider_client_factory=FakeProviderClientFactory(),
            session_dir=session_dir,
            enabled_tools=("read_file",),
        )

        assert container.tool_registry.has("read_file") is True
        assert container.tool_registry.has("bash") is False
        assert [schema["function"]["name"] for schema in container.tool_registry.schemas] == ["read_file"]
        assert container.turn_runner._tool_schemas == container.tool_registry.schemas


def test_container_can_disable_user_question_tool_for_worker_agents() -> None:
    cache_dir = PROJECT_ROOT / ".pytest_cache"
    cache_dir.mkdir(exist_ok=True)
    settings = AppSettings(
        settings_path=cache_dir / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )

    with tempfile.TemporaryDirectory(dir=cache_dir) as session_dir:
        default_container = build_agent_container(
            settings=settings,
            provider_client_factory=FakeProviderClientFactory(),
            session_dir=session_dir,
        )
        worker_container = build_agent_container(
            settings=settings,
            provider_client_factory=FakeProviderClientFactory(),
            session_dir=session_dir,
            enable_user_question=False,
        )

        assert default_container.tool_registry.has("ask_user_question") is True
        assert worker_container.tool_registry.has("ask_user_question") is False
        assert "ask_user_question" not in {
            schema["function"]["name"] for schema in worker_container.tool_registry.schemas
        }


def test_container_rejects_unknown_enabled_tools() -> None:
    cache_dir = PROJECT_ROOT / ".pytest_cache"
    cache_dir.mkdir(exist_ok=True)
    settings = AppSettings(
        settings_path=cache_dir / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )

    with tempfile.TemporaryDirectory(dir=cache_dir) as session_dir:
        with pytest.raises(ValueError, match=r"Unknown enabled tool\(s\): missing_tool"):
            build_agent_container(
                settings=settings,
                provider_client_factory=FakeProviderClientFactory(),
                session_dir=session_dir,
                enabled_tools=("missing_tool",),
            )


def test_container_does_not_resolve_team_agent_outside_workspace(tmp_path, monkeypatch) -> None:
    initialize_team_project(tmp_path, project_id="quant-project")
    monkeypatch.chdir(tmp_path)
    settings = AppSettings(
        settings_path=tmp_path / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )

    container = build_agent_container(
        settings=settings,
        provider_client_factory=FakeProviderClientFactory(),
        session_dir=str(tmp_path / "sessions"),
    )

    assert Path.cwd() == tmp_path.resolve()
    assert container.session_store._workspace_root is None
    assert container.session_store._project_id is None
    assert container.session_store._owner_agent_id is None
    assert container.session_store._session_type is None

    monkeypatch.chdir(tmp_path / "agents" / "main-agent")
    container = build_agent_container(
        settings=settings,
        provider_client_factory=FakeProviderClientFactory(),
        session_dir=str(tmp_path / "sessions-agent-root"),
    )

    assert Path.cwd() == (tmp_path / "agents" / "main-agent").resolve()
    assert container.session_store._workspace_root is None
    assert container.session_store._owner_agent_id is None


def test_container_rejects_agent_flag_outside_matching_workspace(tmp_path, monkeypatch) -> None:
    initialize_team_project(tmp_path, project_id="quant-project")
    monkeypatch.chdir(tmp_path)
    settings = AppSettings(
        settings_path=tmp_path / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )

    with pytest.raises(ValueError, match="inside that agent workspace"):
        build_agent_container(
            settings=settings,
            provider_client_factory=FakeProviderClientFactory(),
            session_dir=str(tmp_path / "sessions"),
            agent_id="main-agent",
        )


def test_container_resolves_team_agent_capsule_context_from_workspace(tmp_path, monkeypatch) -> None:
    initialize_team_project(tmp_path, project_id="quant-project")
    workspace = tmp_path / "agents" / "main-agent" / "workspace"
    monkeypatch.chdir(workspace)
    settings = AppSettings(
        settings_path=tmp_path / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="high",
        user_agent="test-agent",
    )

    container = build_agent_container(
        settings=settings,
        provider_client_factory=FakeProviderClientFactory(),
        session_dir=str(tmp_path / "sessions"),
        agent_id="main-agent",
    )

    assert Path.cwd() == workspace.resolve()
    assert container.session_store._workspace_root == str(workspace.resolve())
    assert container.session_store._project_id == "quant-project"
    assert container.session_store._owner_agent_id == "main-agent"
    assert container.session_store._session_type == "direct_agent_chat"
    assert container.skill_repository._project_skill_dir == (workspace / ".aiteam" / "skills").resolve()
    assert "main agent" in container.session_store.system_prompt.lower()
