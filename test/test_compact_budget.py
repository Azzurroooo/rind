"""Compression budgets preserve message boundaries and user constraints."""

import copy
import json
from unittest.mock import AsyncMock

import pytest

from agent.application.context.compaction import CompactionService
from agent.application.context.estimator import ContextBudget, ContextEstimator
from agent.application.context.manager import ContextManager
from agent.domain.errors import ProviderError
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
def test_oversized_single_unit_is_bounded_without_mutating_messages(role):
    content = "HEAD_CONSTRAINT " + ("unique constraint " * 6000) + " TAIL_CONSTRAINT"
    message = {"role": role, "content": content, "attachments": [{"path": "huge.png", "mime_type": "image/png", "width": 1024, "height": 1024, "size_bytes": 4096}]}
    if role == "tool_arguments":
        message = {"role": "assistant", "tool_calls": [{"id": "c", "function": {"name": "write", "arguments": json.dumps({"content": content})}}]}
    before = copy.deepcopy(message)
    messages = CompactionService()._prepare_summary_request([message], 1, 8192, 800)
    payload = corpus_from_request(messages)
    assert message == before
    assert "truncated to fit the summary budget" in payload["note"]
    serialized = json.dumps(payload["history"] + payload["retained_recent_messages"])
    assert "HEAD_CONSTRAINT" in serialized
    assert "TAIL_CONSTRAINT" in serialized
    assert "characters omitted for summary budget" in serialized
    assert not any(item.get("attachments") for item in messages)
    assert ContextEstimator().estimate_messages(messages).estimated_input_tokens <= 8192 - 800 - 8192 // 20


def test_oversized_history_is_trimmed_from_the_oldest_end_until_the_summary_fits():
    corpus = [
        {"role": "user", "content": "huge old requirement " * 3000},
        {"role": "user", "content": "still-relevant older fact"},
        {"role": "user", "content": "latest correction"},
        {"role": "assistant", "content": "pending task"},
    ]

    messages = CompactionService()._prepare_summary_request(corpus, 2, 8192, 800)
    payload = corpus_from_request(messages)

    assert payload["history"] == [{"role": "user", "content": "still-relevant older fact"}], "the oldest messages are dropped, the rest kept"
    assert [message["content"] for message in payload["retained_recent_messages"]] == ["latest correction", "pending task"]
    assert "dropped" in payload["note"] and "1 oldest history messages" in payload["note"]
    assert ContextEstimator().estimate_messages(messages).estimated_input_tokens <= 8192 - 800 - 8192 // 20


def test_trimmed_history_does_not_send_its_images():
    corpus = [
        {"role": "user", "content": "large old history " * 6000, "attachments": [{"path": "old.png", "mime_type": "image/png", "size_bytes": 100, "width": 32, "height": 32}]},
        {"role": "user", "content": "recent constraint"},
    ]
    messages = CompactionService()._prepare_summary_request(corpus, 1, 8192, 800)
    assert corpus_from_request(messages)["history"] == []
    assert not any(message.get("attachments") for message in messages)


def test_one_large_old_unit_does_not_discard_other_constraints():
    corpus = [{"role": "user", "content": "obsolete detail " * 10000}]
    corpus.extend({"role": "user", "content": f"Keep constraint {index}"} for index in range(20))
    corpus.append({"role": "assistant", "content": "recent task"})
    request = CompactionService()._prepare_summary_request(corpus, 21, 8192, 800)
    payload = corpus_from_request(request)
    assert payload["history"] == corpus[1:21]
    assert "1 oldest history messages" in payload["note"]


@pytest.mark.asyncio
async def test_a_history_too_large_to_summarize_still_compacts(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    for index in range(4):
        await session.persist_message("user", f"old requirement {index} " * 800)
        await session.persist_message("assistant", f"old answer {index} " * 800)
    await session.persist_message("user", "latest correction")
    await session.persist_message("assistant", "pending task")
    provider = AsyncMock()
    provider.create.return_value = ModelCompletion(content="handoff after trimming", finish_reason="stop")
    manager = ContextManager(estimator=ContextEstimator(ContextBudget(context_window_tokens=8192)))
    runner = TurnRunner(chat_client=provider, tool_processor=None, stream_parser=None, tool_schemas=[], context_manager=manager)

    record = await runner.compact_context(session)

    assert record["handoff_message"]["content"] == "handoff after trimming", "the summary runs instead of being refused"
    assert record["strategy"] == "llm_inline"
    request = provider.create.call_args.kwargs
    corpus = corpus_from_request(request["messages"])
    assert [message["content"] for message in corpus["retained_recent_messages"]] == ["latest correction", "pending task"], "the newest messages stay verbatim"
    assert "dropped" in corpus["note"]
    assert ContextEstimator().estimate_messages(request["messages"]).estimated_input_tokens <= 8192 - request["max_output_tokens"] - 8192 // 20
    assert await session.get_latest_compaction() is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["manual", "auto", "context_length_error"])
async def test_oversized_single_message_compacts_across_all_reasons(tmp_path, monkeypatch, reason):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "Keep every numbered requirement. " * 5000)
    before = await session.load_messages()
    provider = AsyncMock()
    provider.create.return_value = ModelCompletion(content="summarized single oversized message", finish_reason="stop")
    manager = ContextManager(estimator=ContextEstimator(ContextBudget(context_window_tokens=8192)))
    runner = TurnRunner(chat_client=provider, tool_processor=None, stream_parser=None, tool_schemas=[], context_manager=manager)
    if reason == "manual":
        record = await runner.compact_context(session)
    else:
        _, record = await runner._run_compact(
            session=session,
            context=await manager.build_messages_async(session),
            reason=reason,
            phase="mid_turn",
        )
    assert record["strategy"] == "llm_inline"
    assert record["handoff_message"]["content"] == "summarized single oversized message"
    request = provider.create.call_args.kwargs
    assert ContextEstimator().estimate_messages(request["messages"]).estimated_input_tokens <= 8192 - request["max_output_tokens"] - 8192 // 20
    assert (await session.load_messages())[: len(before)] == before
    rebuilt = await manager.build_messages_async(session)
    assert rebuilt.stats["estimated_input_tokens"] < 500


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


@pytest.mark.asyncio
async def test_compaction_retries_with_smaller_budget_on_provider_context_overflow(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    for index in range(6):
        await session.persist_message("user", f"requirement {index} " * 400)
    provider = AsyncMock()
    provider.create.side_effect = [
        ProviderError("prompt is too long", status="rejected", code="context_length_exceeded"),
        ModelCompletion(content="handoff after overflow retry", finish_reason="stop"),
    ]
    record = await CompactionService().compact_async(
        session,
        await session.get_messages_slice(),
        provider,
        context_stats={"context_window_tokens": 12000},
    )
    assert record["strategy"] == "llm_inline"
    assert record["handoff_message"]["content"] == "handoff after overflow retry"
    first_call, second_call = (call.kwargs for call in provider.create.call_args_list)
    assert second_call["max_output_tokens"] < first_call["max_output_tokens"]


@pytest.mark.parametrize("message_text,status_code,expected_code", [
    ("prompt is too long: 205000 tokens > 200000 maximum", 400, "context_length_exceeded"),
    ("Your input exceeds the context window of this model.", 400, "context_length_exceeded"),
    ("The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).", 400, "context_length_exceeded"),
    ("invalid_request_error: context window exceeds limit", 400, "context_length_exceeded"),
    ("exceeded model token limit", 400, "context_length_exceeded"),
    ("Payload Too Large", 413, "context_length_exceeded"),
    ("Too many tokens, please wait before trying again.", 429, ""),
    ("Rate limit reached for tokens per minute (TPM).", 429, ""),
])
def test_provider_error_classifies_context_overflow_without_matching_rate_limits(message_text, status_code, expected_code):
    from agent.infrastructure.llm.errors import provider_error

    class StatusError(Exception):
        def __init__(self, msg, code):
            super().__init__(msg)
            self.status_code = code

    err = provider_error(StatusError(message_text, status_code))
    assert err.code == expected_code


def test_anthropic_and_responses_usage_normalization():
    from agent.infrastructure.llm.anthropic_messages import _events as anthropic_events, _usage as anthropic_usage
    from agent.infrastructure.llm.openai_responses import _events as responses_events, _usage as responses_usage

    initial = anthropic_usage({"input_tokens": 50, "cache_read_input_tokens": 1200, "cache_creation_input_tokens": 300, "output_tokens": 1})
    assert initial.input_tokens == 1550
    assert initial.cached_tokens == 1200
    assert initial.output_tokens == 1

    delta_events, merged = anthropic_events(
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 42, "output_tokens_details": {"thinking_tokens": 15}}},
        initial,
    )
    assert merged.input_tokens == 1550
    assert merged.cached_tokens == 1200
    assert merged.output_tokens == 42
    assert merged.reasoning_tokens == 15
    assert [e.kind for e in delta_events] == ["usage", "completed"]

    resp_usage = responses_usage({"input_tokens": 500, "output_tokens": 80, "input_tokens_details": {"cached_tokens": 400}, "output_tokens_details": {"reasoning_tokens": 35}})
    assert resp_usage.input_tokens == 500
    assert resp_usage.cached_tokens == 400
    assert resp_usage.reasoning_tokens == 35

    with pytest.raises(ProviderError) as exc_info:
        responses_events({"type": "response.failed", "response": {"error": {"code": "context_length_exceeded", "message": "Your input exceeds the context window."}}})
    assert exc_info.value.code == "context_length_exceeded"


@pytest.mark.asyncio
async def test_reduce_hard_limit_uses_reference_tokens_and_rescue_strips_heavy_fields(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    raw_args = json.dumps({"body": " ".join(f"line_{i}" for i in range(400))})
    await session.persist_message("user", "start work")
    await session.persist_message(
        "assistant",
        " ".join(f"reply_{i}" for i in range(300)),
        reasoning_content=" ".join(f"thought_{i}" for i in range(300)),
        meta={"tool_calls": [{"id": "c1", "name": "write", "raw_args": raw_args}]},
    )
    await session.persist_tool_call("c1", "write", {"body": "x"}, raw_args, "s", "e", '{"ok":true}', model_content=" ".join(f"out_{i}" for i in range(300)))
    await session.persist_message("user", "latest question")
    await session.persist_message("assistant", "latest answer")

    manager = ContextManager(estimator=ContextEstimator(ContextBudget(context_window_tokens=256000)))
    initial = await manager.build_messages_async(session)
    initial_tokens = initial.stats["estimated_input_tokens"]
    assert 1000 < initial_tokens < 256000

    reduced = manager.reduce_hard_limit(factor=0.5, reference_tokens=initial_tokens)
    assert reduced == int(initial_tokens * 0.5)

    rescued = await manager.build_messages_async(session, allow_rescue=True)
    assert rescued.stats["estimated_input_tokens"] <= reduced


def test_handoff_builder_bounds_rendered_tool_lines():
    from agent.application.context.handoff import CompactionHandoffBuilder

    builder = CompactionHandoffBuilder()
    ids = [f"call_{i}" for i in range(35)]
    lines = builder.render_tool_lines(ids, [{"id": f"call_{i}", "name": "bash", "ok": True} for i in range(35)])
    assert len(lines) == 21
    assert lines[0] == "- [15 earlier tool calls omitted]"
    assert lines[-1].startswith("- call_34:")


def test_custom_connection_resolves_catalog_context_window_from_known_endpoint(tmp_path):
    from agent.infrastructure.llm.catalog import ProviderDefinition
    from agent.infrastructure.llm.provider_service import ProviderServiceImpl
    from agent.infrastructure.settings import AppSettings

    service = ProviderServiceImpl()
    custom = ProviderDefinition(
        id="my-anthropic-proxy",
        name="My Anthropic",
        api="anthropic-messages",
        default_base_url="https://api.anthropic.com",
        auth_methods=("connection",),
    )
    settings = AppSettings(tmp_path / "settings.json", False, "claude-opus-4-6", "my-anthropic-proxy", "https://api.anthropic.com", "")
    resolved = service._resolve_model(settings, custom, "claude-opus-4-6", {"base_url": "https://api.anthropic.com"})
    assert resolved.context_window == 1_000_000
    assert resolved.image_input is True
