import asyncio

import pytest

from agent.application.tools.executor import ToolExecutor
from agent.domain.errors import (
    PersistenceError,
    ProviderError,
    RenderingError,
)
from agent.domain.events import ToolResultEvent, TurnFailedEvent
from agent.infrastructure.llm.openai_chat_client import OpenAIChatClient


class _Registry:
    def __init__(self, error=None):
        self.error = error

    def has(self, name):
        return True

    def is_async(self, name):
        return False

    def call(self, name, args):
        if self.error:
            raise self.error
        return "ok"

    async def call_async(self, name, args):
        return self.call(name, args)


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (TypeError("bad arguments"), "rejected"),
        (TimeoutError("deadline"), "timed_out"),
        (RuntimeError("broken"), "failed"),
    ],
)
def test_tool_executor_classifies_sync_boundary_failures(error, status):
    result = ToolExecutor(_Registry(error)).execute_sync("demo", {})
    assert result.status == "error"
    assert result.failure_status == status


def test_unknown_tool_is_unavailable():
    class MissingRegistry(_Registry):
        def has(self, name):
            return False

    result = ToolExecutor(MissingRegistry()).execute_sync("missing", {})
    assert result.failure_status == "unavailable"


def test_tool_executor_does_not_turn_cancellation_into_failure():
    class CancelRegistry(_Registry):
        def call(self, name, args):
            raise asyncio.CancelledError("user stop")

    with pytest.raises(asyncio.CancelledError):
        ToolExecutor(CancelRegistry()).execute_sync("demo", {})


def test_boundary_statuses_are_serializable_and_distinct():
    statuses = ["cancelled", "rejected", "failed", "timed_out", "unavailable"]
    assert {TurnFailedEvent(status=status).status for status in statuses[1:]} == set(statuses[1:])
    assert {ToolResultEvent(status=status).status for status in statuses} == set(statuses)


def test_provider_error_classification_and_boundary_sources():
    client = OpenAIChatClient(object(), "model")
    assert client._provider_error(TimeoutError("deadline")).status == "timed_out"
    assert ProviderError("offline", status="unavailable").source == "provider"
    assert PersistenceError("disk").source == "persistence"
    assert RenderingError("console").source == "rendering"
