"""Production composition-root tests."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.bootstrap import AgentContainer, build_agent_container
from agent.bootstrap import container as container_module


def test_container_explicitly_shares_production_dependencies(monkeypatch) -> None:
    monkeypatch.setattr(
        container_module.Config,
        "get_async_client",
        classmethod(lambda cls: object()),
    )

    cache_dir = PROJECT_ROOT / ".pytest_cache"
    cache_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache_dir) as session_dir:
        container = build_agent_container(session_dir=session_dir)

        assert isinstance(container, AgentContainer)
        assert container.runtime._turn_runner is container.turn_runner
        assert container.runtime._session_store is container.session_store
        assert container.turn_runner._tool_processor is container.tool_processor
        assert container.turn_runner._context_manager is container.context_manager
        assert container.turn_runner._compaction_service is container.compaction_service
        assert container.tool_processor._tool_executor is container.tool_executor
        assert container.tool_processor._tool_result_normalizer is container.tool_result_normalizer
        assert container.context_manager._estimator is container.context_estimator
        assert not hasattr(container, "cli")
