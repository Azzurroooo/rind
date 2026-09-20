"""Compression budgets preserve message boundaries and user constraints."""

import copy
import json
from unittest.mock import AsyncMock

import pytest

from agent.application.context.compaction import CompactionService
from agent.application.context.estimator import ContextBudget, ContextEstimator
from agent.application.context.manager import ContextManager
from agent.domain.errors import BoundaryError
from agent.domain.models import ModelCompletion
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.runtime.core.turn_runner import TurnRunner


def corpus_from_request(messages):
    return json.loads(messages[1]["content"].split("Compression corpus JSON:\n", 1)[1])


def long_tool_conversation():
    return [
        {"role": "user", "content": "Start the migration."},
        {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"schema.sql"}'}}], "reasoning_content": "private deliberation"},
        {"role": "tool", "tool_call_id": "call-1", "content": "HEAD\n" + "database column record value\n" * 6000 + "\nTAIL"},
        {"role": "user", "content": "Correction: PostgreSQL only; preserve all existing customer IDs."},
        {"role": "assistant", "content": "Migration is pending.", "reasoning_content": "private deliberation"},
    ]


@pytest.mark.parametrize("window,shortened", [(200000, False), (8192, True)])
@pytest.mark.parametrize("constraint", ["PostgreSQL only; preserve all customer IDs.", "必须使用 PostgreSQL，保留全部客户编号，不允许删除历史数据。"])
def test_tool_body_shortens_only_when_needed_and_keeps_middle_constraint(window, shortened, constraint):
    original = long_tool_conversation()
    original[3]["content"] = constraint
    before = copy.deepcopy(original)
    service = CompactionService()
    corpus = service.build_compression_corpus(original)
    messages = service._prepare_summary_request(corpus, 3, window, 800)
    payload = corpus_from_request(messages)
    actual = payload["history"] + payload["retained_recent_messages"]
    assert original == before
    assert len(actual) == len(original)
    for index in (0, 1, 3, 4):
        assert actual[index] == {key: value for key, value in original[index].items() if key != "reasoning_content"}
    assert actual[2]["tool_call_id"] == "call-1"
    assert actual[2]["content"].startswith("HEAD\n")
    assert actual[2]["content"].endswith("\nTAIL")
    assert ("characters omitted" in actual[2]["content"]) is shortened
    if not shortened:
        assert actual[2]["content"] == original[2]["content"]
        assert len(messages[1]["content"]) > 100000
    assert "private deliberation" not in str(messages)
    assert ContextEstimator().estimate_messages(messages).estimated_input_tokens <= window - 800 - window // 20


@pytest.mark.parametrize("role", ["user", "assistant", "tool_arguments"])
def test_irreducible_content_is_rejected_without_mutating_messages(role):
    content = "unique constraint " * 6000
    message = {"role": role, "content": content}
    if role == "tool_arguments":
        message = {"role": "assistant", "tool_calls": [{"id": "c", "function": {"name": "write", "arguments": json.dumps({"content": content})}}]}
    before = copy.deepcopy(message)
    with pytest.raises(BoundaryError, match="History was preserved") as failure:
        CompactionService()._prepare_summary_request([message], 1, 8192, 800)
    assert failure.value.code == "compact_input_too_large"
    assert message == before


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["manual", "auto", "context_length_error"])
async def test_over_budget_never_calls_provider_or_commits_boundary(tmp_path, monkeypatch, reason):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "Keep every numbered requirement. " * 5000)
    before = await session.load_messages()
    provider = AsyncMock()
    manager = ContextManager(estimator=ContextEstimator(ContextBudget(context_window_tokens=8192)))
    runner = TurnRunner(chat_client=provider, tool_processor=None, stream_parser=None, tool_schemas=[], context_manager=manager)
    if reason == "manual":
        with pytest.raises(BoundaryError, match="Compact input exceeds"):
            await runner.compact_context(session)
    elif reason == "auto":
        events = [event async for event in runner.run_turn(session)]
        assert events[-1].error_type == "BoundaryError"
        assert "Compact input exceeds" in events[-1].error
    else:
        with pytest.raises(BoundaryError, match="Compact input exceeds"):
            await runner._run_compact(session=session, context=await manager.build_messages_async(session), reason=reason, phase="mid_turn")
    provider.create.assert_not_called()
    provider.stream.assert_not_called()
    assert await session.get_latest_compaction() is None
    assert await session.load_messages() == before


@pytest.mark.asyncio
async def test_actual_cut_separates_recent_messages_and_preserves_next_context(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "old goal")
    await session.persist_message("assistant", "older facts " * 4000)
    await session.persist_message("user", "latest correction")
    await session.persist_message("assistant", "unfinished task", reasoning_content="preserve for normal continuation")
    provider = AsyncMock()
    provider.create.return_value = ModelCompletion(content="old goal, newer correction, task pending", finish_reason="stop")
    manager = ContextManager()
    runner = TurnRunner(chat_client=provider, tool_processor=None, stream_parser=None, tool_schemas=[], context_manager=manager)
    record = await runner.compact_context(session)
    request = provider.create.call_args.kwargs
    assert request["max_output_tokens"] == 8192
    assert request["reasoning_effort"] == "low"
    corpus = corpus_from_request(request["messages"])
    assert [m["content"] for m in corpus["retained_recent_messages"]] == ["latest correction", "unfinished task"]
    assert corpus["history"][0]["content"] == "old goal"
    assert all("id" not in m and "reasoning_content" not in m for part in corpus.values() for m in part)
    continuation = (await manager.build_messages_async(session)).messages
    assert continuation[-2]["content"] == "latest correction"
    assert continuation[-1]["reasoning_content"] == "preserve for normal continuation"
    assert all("id" not in m for m in continuation)
    await runner.compact_context(session)
    corpus = corpus_from_request(provider.create.call_args.kwargs["messages"])
    assert any(m.get("content") == record["handoff_message"]["content"] for m in corpus["history"])


@pytest.mark.asyncio
async def test_cut_keeps_parallel_tool_calls_and_results_in_same_section(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "old requirements " * 4000)
    calls = [{"id": f"c{i}", "name": "read_file", "raw_args": '{"path":"notes"}'} for i in range(2)]
    await session.persist_message("assistant", "", meta={"tool_calls": calls}, reasoning_content="original thoughts")
    for call in calls:
        await session.persist_tool_call(
            call["id"], call["name"], {"path": "notes"}, call["raw_args"], "start", "end",
            '{"ok":true}', model_content="evidence " + call["id"],
        )
    provider = AsyncMock()
    provider.create.return_value = ModelCompletion(content="Requirements; read results before continuing.", finish_reason="stop")
    manager = ContextManager()
    runner = TurnRunner(chat_client=provider, tool_processor=None, stream_parser=None, tool_schemas=[], context_manager=manager)
    await runner.compact_context(session)
    recent = corpus_from_request(provider.create.call_args.kwargs["messages"])["retained_recent_messages"]
    assert [m["role"] for m in recent] == ["assistant", "tool", "tool"]
    assert [c["id"] for c in recent[0]["tool_calls"]] == ["c0", "c1"]
    assert [m["tool_call_id"] for m in recent[1:]] == ["c0", "c1"]
    continued = (await manager.build_messages_async(session)).messages
    assert continued[-3]["reasoning_content"] == "original thoughts"
    assert [m["tool_call_id"] for m in continued[-2:]] == ["c0", "c1"]


@pytest.mark.asyncio
async def test_small_window_gets_smaller_output_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "small task")
    provider = AsyncMock()
    provider.create.return_value = ModelCompletion(content="task pending", finish_reason="stop")
    await CompactionService().compact_async(session, await session.get_messages_slice(), provider, context_stats={"context_window_tokens": 8192})
    assert provider.create.call_args.kwargs["max_output_tokens"] == 819
