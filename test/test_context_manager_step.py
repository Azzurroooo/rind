import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from agent.application.services.context_estimator import ContextBudget, ContextEstimator
from agent.application.services.context_manager import ContextManager


class MockSession:
    def __init__(self):
        self.messages = []

    async def get_messages_slice(self):
        return [dict(message) for message in self.messages]


@pytest.mark.asyncio
async def test_context_manager_step_auto_compact_threshold_is_decision_signal():
    budget = ContextBudget(
        conversation_budget_tokens=10,
        tool_budget_tokens=500,
        hard_limit_tokens=2000,
        context_window_tokens=100,
        auto_compact_token_limit_percent=10,
    )
    manager = ContextManager(estimator=ContextEstimator(budget=budget), hot_message_limit=2)
    session = MockSession()
    for index in range(10):
        session.messages.append({"role": "user", "content": f"Message {index} " + ("x" * 40)})

    first = await manager.build_messages_async(session)
    second = await manager.build_messages_async(session)

    assert first.messages == session.messages
    assert second.messages == first.messages
    assert first.decisions["auto_compact_token_limit_reached"] is True
    assert "compact_recommended" not in first.decisions
    assert "rolling_summary_generated" not in first.decisions
    assert "cold_compacted_message_count" not in first.stats
