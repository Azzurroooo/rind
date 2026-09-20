"""Shared compact pipeline with real session persistence and a local model stub."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from agent.application.context.manager import ContextManager
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.compaction import COMPACT_HANDOFF_REASONING_CONTENT
from agent.domain.errors import PersistenceError
from agent.domain.message_boundary import validate_compact_handoff_boundary
from agent.domain.models import ModelCompletion, ModelUsage
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.runtime.core.turn_runner import TurnRunner


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["manual", "auto", "context_length_error"])
@pytest.mark.parametrize("outcome", ["success", "empty", "truncated", "provider_error", "cancelled", "cancelled_return", "persist_error"])
async def test_compact_pipeline_outcomes_and_reopened_context(tmp_path, monkeypatch, reason, outcome):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), model="local-test", system_prompt="Keep instructions.")
    await session.initialize()
    await session.persist_message("user", "Keep the contract: answer 42.")
    await session.persist_message("assistant", "Understood.", reasoning_content="original reasoning")
    await session.set_skill_catalog([{"name": "example", "description": "catalog marker", "scope": "project"}])
    source = CancellationTokenSource()
    summary_requests = []

    class Client:
        async def create(self, **kwargs):
            summary_requests.append(kwargs["messages"])
            if outcome == "provider_error":
                raise RuntimeError("provider unavailable")
            if outcome == "cancelled":
                raise asyncio.CancelledError("provider cancelled")
            if outcome == "cancelled_return":
                source.cancel("cancelled during response")
            return ModelCompletion(
                content="" if outcome == "empty" else "Retain the contract: answer 42.",
                reasoning_content="summary reasoning must not be replayed",
                finish_reason="length" if outcome == "truncated" else "stop",
                usage=ModelUsage(input_tokens=100, output_tokens=20, reasoning_tokens=10),
            )

    manager = ContextManager()
    runner = TurnRunner(chat_client=Client(), tool_processor=None, stream_parser=None, tool_schemas=[], context_manager=manager)
    transient = [{"role": "system", "content": "Current turn instructions."}]
    if outcome == "persist_error":
        monkeypatch.setattr(session, "persist_compaction", AsyncMock(side_effect=OSError("disk unavailable")))

    async def compact():
        if reason == "manual":
            return await runner.compact_context(session, cancellation_token=source.token)
        context = await manager.build_messages_async(session=session, transient_system_messages=transient)
        rebuilt, record = await runner._run_compact(
            session=session, context=context, reason=reason, phase="mid_turn",
            phase_detail="context_length_recovery" if reason == "context_length_error" else "before_first_sampling",
            transient_system_messages=transient, cancellation_token=source.token,
        )
        assert transient[0] in rebuilt.messages
        return record

    if outcome in {"cancelled", "cancelled_return"}:
        with pytest.raises(asyncio.CancelledError):
            await compact()
        assert await session.get_latest_compaction() is None
    elif outcome == "persist_error":
        with pytest.raises(PersistenceError, match="disk unavailable"):
            await compact()
        assert await session.get_latest_compaction() is None
    else:
        record = await compact()
        assert record["reason"] == reason
        assert record["strategy"] == ("llm_inline" if outcome == "success" else "deterministic_fallback")
        if outcome != "provider_error":
            assert record["usage"]["input_tokens"] == 100
            assert record["usage"]["output_tokens"] == 20
        assert "reasoning_content" not in record["handoff_message"]
        assert (await session.get_latest_compaction())["id"] == record["id"]
        reopened = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=session.session_id)
        await reopened.initialize()
        context = await manager.build_messages_async(session=reopened)
        assert validate_compact_handoff_boundary(context.messages).ok
        handoff = next(message for message in context.messages if message.get("reasoning_content") == COMPACT_HANDOFF_REASONING_CONTENT)
        assert handoff["content"] == record["handoff_message"]["content"]
        assert "catalog marker" in str(context.messages)
        await reopened.persist_message("user", "Continue after reopening.")
        continued = await manager.build_messages_async(session=reopened)
        assert continued.messages[-1]["content"] == "Continue after reopening."
        assert validate_compact_handoff_boundary(continued.messages).ok
        if outcome == "success":
            session = reopened
            second = await compact()
            assert second["id"] != record["id"]
            assert (await reopened.get_latest_compaction())["id"] == second["id"]
            repeated = await manager.build_messages_async(session=reopened)
            assert validate_compact_handoff_boundary(repeated.messages).ok
    assert len(summary_requests) == (2 if outcome == "success" else 1)
    assert "catalog marker" not in str(summary_requests)


@pytest.mark.asyncio
async def test_already_cancelled_compact_does_not_call_provider_or_persist():
    from agent.application.context.compaction import CompactionService

    source = CancellationTokenSource()
    source.cancel("already cancelled")
    session, client = AsyncMock(), AsyncMock()
    with pytest.raises(asyncio.CancelledError, match="already cancelled"):
        await CompactionService().compact_async(session, [], client, cancellation_token=source.token)
    client.create.assert_not_awaited()
    session.persist_compaction.assert_not_awaited()
