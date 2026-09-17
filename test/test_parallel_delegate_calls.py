"""Parallel foreground delegate scheduling tests."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.tools import ToolCallProcessor, ToolResultNormalizer
from agent.domain import ParsedToolCall, ToolExecutionResult, tool_ok


class _Session:
    async def get_tool_records(self, **kwargs):
        return []

    session_id = "parent"

    def __init__(self) -> None:
        self.persisted_calls: list[str] = []

    def now_iso(self) -> str:
        return "2026-08-09T00:00:00Z"

    async def persist_tool_call(self, call_id, *args, **kwargs) -> None:
        self.persisted_calls.append(call_id)

    async def persist_message(self, *args, **kwargs) -> None:
        return None


class _SlowDelegateExecutor:
    def is_async_tool(self, name: str) -> bool:
        return name == "delegate"

    async def execute_async(self, name: str, args: dict, raw_args: str | None = None) -> ToolExecutionResult:
        await asyncio.sleep(0.12)
        return ToolExecutionResult(status="ok", result_str=tool_ok(name, {"agent_id": args["agent_id"]}))


@pytest.mark.asyncio
async def test_multiple_delegate_calls_run_in_parallel_and_persist_in_call_order() -> None:
    processor = ToolCallProcessor(
        tool_executor=_SlowDelegateExecutor(),
        tool_result_normalizer=ToolResultNormalizer(),
    )
    session = _Session()
    calls = [
        ParsedToolCall("delegate-1", "delegate", '{"agent_id":"researcher","task":"one"}'),
        ParsedToolCall("delegate-2", "delegate", '{"agent_id":"reviewer","task":"two"}'),
    ]

    started = time.perf_counter()
    events = [event async for event in processor.execute(session, calls)]
    elapsed = time.perf_counter() - started

    assert elapsed < 0.22
    assert session.persisted_calls == ["delegate-1", "delegate-2"]
    assert [event.tool_call_id for event in events if event.type == "tool_result"] == ["delegate-1", "delegate-2"]


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [1, 2])
@pytest.mark.parametrize("failure", ["record", "message", "cancel"])
async def test_tool_persistence_failure_is_reported_before_stopping(count, failure):
    from agent.domain.errors import PersistenceError

    class FailingSession(_Session):
        async def persist_tool_call(self, *args, **kwargs):
            if failure == "cancel":
                raise asyncio.CancelledError()
            if failure == "record":
                raise OSError("disk full")
            await super().persist_tool_call(*args, **kwargs)

        async def persist_message(self, *args, **kwargs):
            raise OSError("disk full")

    processor = ToolCallProcessor(tool_executor=_SlowDelegateExecutor())
    calls = [ParsedToolCall(f"call-{i}", "delegate", '{"agent_id":"reviewer"}') for i in range(count)]
    events = []
    with pytest.raises(asyncio.CancelledError if failure == "cancel" else PersistenceError):
        async for event in processor.execute(FailingSession(), calls):
            events.append(event)
    results = [event for event in events if event.type == "tool_result"]
    if failure == "cancel":
        assert results == []
    else:
        assert len(results) == 1
        assert results[0].tool_call_id == "call-0"
        assert results[0].error_source == "persistence"
        assert results[0].status == "failed"
