import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import CompactionService
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT
from agent.domain.models import ModelCompletion, ModelUsage
from agent.infrastructure.planning import build_plan_snapshot


class FakeSession:
    def __init__(self):
        self.records = []

    async def load_messages(self):
        return [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "goal"},
            {"role": "assistant", "content": "progress"},
        ]

    async def get_tool_records(self, *args, **kwargs):
        return []

    async def get_latest_compaction(self):
        return None

    async def persist_compaction(self, record):
        self.records.append(dict(record))
        return dict(record)


def _active_plan() -> dict:
    return {
        "schema_version": "2.0",
        "plan": [
            {"step": "Inspect context builder", "status": "completed"},
            {"step": "Append compact snapshot", "status": "in_progress"},
            {"step": "Update tests", "status": "pending"},
        ],
    }


def _set_plan_context(root: Path, plan: dict | str | None = None) -> Path:
    session_id = "sid"
    base = root / session_id
    base.mkdir(parents=True, exist_ok=True)
    if isinstance(plan, dict):
        (base / "plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
    elif isinstance(plan, str):
        (base / "plan.json").write_text(plan, encoding="utf-8")
    return base


def test_compaction_service_uses_full_source_for_mid_turn() -> None:
    service = CompactionService()
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "do task"},
        {"role": "assistant", "content": "", "meta": {"tool_calls": [{"id": "call_1", "name": "bash"}]}},
        {"role": "tool", "tool_call_id": "call_1", "content": "tool result"},
    ]

    record = service.build_compaction(messages, phase="mid_turn")

    assert set(record["source"]) == {
        "message_start_index",
        "message_end_index_exclusive",
        "tool_call_ids",
        "history_digest",
    }
    assert record["source"]["message_start_index"] == 0
    assert record["source"]["message_end_index_exclusive"] == len(messages)
    assert record["source"]["tool_call_ids"] == ["call_1"]
    assert record["continuation_user_message"] == {
        "role": "user",
        "content": COMPACT_CONTINUATION_USER_CONTENT,
    }
    assert record["handoff_message"]["role"] == "assistant"
    assert "do task" in record["handoff_message"]["content"]


def test_compaction_service_retains_recent_suffix_within_budget() -> None:
    service = CompactionService()
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old " * 40},
        {"role": "assistant", "content": "older work " * 20},
        {"role": "user", "content": "recent question " * 4},
        {"role": "assistant", "content": "", "meta": {"tool_calls": [{"id": "call_1", "name": "bash", "raw_args": "{}"}]}},
        {"role": "tool", "tool_call_id": "call_1", "content": ""},
        {"role": "assistant", "content": "recent answer"},
    ]
    tool_records = [{"id": "call_1", "model_content": "tool result " * 10}]

    record = service.build_compaction(messages, tool_records, keep_recent_chars=220)

    assert record["source"]["message_start_index"] == 0
    cut = record["source"]["message_end_index_exclusive"]
    assert cut == 3
    assert messages[cut]["role"] == "user"
    assert all(message["role"] != "tool" for message in messages[:cut])
    assert "old" in record["handoff_message"]["content"]


def test_compaction_service_retention_never_splits_tool_calls_from_results() -> None:
    service = CompactionService()
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "do task"},
        {"role": "assistant", "content": "tool work " * 30, "meta": {"tool_calls": [{"id": "call_1", "name": "bash", "raw_args": '{"command":"date"}'}]}},
        {"role": "tool", "tool_call_id": "call_1", "content": ""},
    ]
    tool_records = [{"id": "call_1", "model_content": "tool result " * 20}]

    record = service.build_compaction(messages, tool_records, keep_recent_chars=len("tool result ") * 20)

    cut = record["source"]["message_end_index_exclusive"]
    assert cut == 2
    assert messages[cut]["role"] == "assistant"
    assert messages[cut + 1]["role"] == "tool"


def test_compaction_service_keep_recent_budget_derives_from_auto_compact_limit() -> None:
    service = CompactionService()

    assert service._keep_recent_chars({"auto_compact_token_limit": 180000}) == 22500
    assert service._keep_recent_chars({}) == 0
    assert service._keep_recent_chars(None) == 0


def test_compaction_service_retains_final_unit_even_when_it_exceeds_budget() -> None:
    service = CompactionService()
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "do task"},
        {"role": "assistant", "content": "", "meta": {"tool_calls": [{"id": "call_1", "name": "bash", "raw_args": "{}"}]}},
        {"role": "tool", "tool_call_id": "call_1", "content": ""},
    ]
    tool_records = [{"id": "call_1", "model_content": "tool result " * 500}]

    record = service.build_compaction(messages, tool_records, keep_recent_chars=10)

    cut = record["source"]["message_end_index_exclusive"]
    assert cut == 2
    assert messages[cut]["role"] == "assistant"
    assert messages[cut + 1]["role"] == "tool"


def test_compaction_service_counts_reasoning_in_final_tool_unit() -> None:
    service = CompactionService()
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old"},
        {"role": "assistant", "content": "", "reasoning_content": "private reasoning", "meta": {"tool_calls": [{"id": "call_1", "name": "bash", "raw_args": "{}"}]}},
        {"role": "tool", "tool_call_id": "call_1", "content": ""},
        {"role": "user", "content": "latest"},
    ]
    tool_records: list[dict[str, str]] = []

    record = service.build_compaction(messages, tool_records, keep_recent_chars=20)

    assert record["source"]["message_end_index_exclusive"] == 4
    assert "private reasoning" not in record["handoff_message"]["content"]


@pytest.mark.asyncio
async def test_compaction_service_falls_back_when_llm_compact_fails() -> None:
    class FailingClient:
        async def create(self, *args, **kwargs):
            raise RuntimeError("provider unavailable")

    with tempfile.TemporaryDirectory() as temp_dir:
        base = _set_plan_context(Path(temp_dir))
        session = FakeSession()
        session.session_base_path = str(base)
        record = await CompactionService().compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=FailingClient(),
            reason="auto",
            phase="mid_turn",
            context_stats={"context_window_tokens": 1000},
        )

    assert record["strategy"] == "deterministic_fallback"
    assert record["reason"] == "auto"
    assert record["phase"] == "mid_turn"
    assert record["policy_version"] == "compact_boundary_v3"
    assert record["fallback_error"]["type"] == "RuntimeError"
    assert record["handoff_message"]["content"].startswith("Context compacted.")
    assert "reasoning_content" not in record["handoff_message"]
    assert session.records[-1]["source"]["message_start_index"] == 0


@pytest.mark.asyncio
async def test_compaction_service_discards_summary_reasoning() -> None:
    class ReasoningClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content="Summarized handoff.",
                            reasoning_content="How the summary was built.",
                        )
                    )
                ]
            )

    session = FakeSession()
    record = await CompactionService().compact_async(
        session=session,
        context_messages=await session.load_messages(),
        chat_client=ReasoningClient(),
        reason="auto",
        phase="mid_turn",
    )

    assert record["strategy"] == "llm_inline"
    assert record["handoff_message"]["content"] == "Summarized handoff."
    assert "reasoning_content" not in record["handoff_message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("content, finish_reason, strategy", [
    ("Summarized handoff.", "stop", "llm_inline"),
    ("  ", "stop", "deterministic_fallback"),
    ("Incomplete summary", "length", "deterministic_fallback"),
    ("Filtered summary", "content_filter", "deterministic_fallback"),
    ("Partial summary", "error", "deterministic_fallback"),
    ("Unexpected tool request", "tool_calls", "deterministic_fallback"),
])
async def test_compaction_records_usage_even_when_summary_is_unusable(content, finish_reason, strategy):
    class UsageSession(FakeSession):
        async def persist_sampling_usage(self, usage):
            persisted_usage.append(usage)

    class Client:
        async def create(self, **kwargs):
            return ModelCompletion(
                content=content,
                reasoning_content="Summary generation reasoning",
                finish_reason=finish_reason,
                usage=ModelUsage(input_tokens=100, output_tokens=30, reasoning_tokens=20),
            )

    persisted_usage = []
    ledger = []
    session = UsageSession()
    record = await CompactionService(usage_recorder=ledger.append).compact_async(
        session, await session.load_messages(), Client(), reason="auto", phase="mid_turn",
    )

    assert record["strategy"] == strategy
    assert persisted_usage == [record["usage"]]
    assert len(ledger) == 1
    assert ledger[0]["sampling_kind"] == "compact"
    assert ledger[0]["input_tokens"] == 100
    assert ledger[0]["output_tokens"] == 30
    assert ledger[0]["reasoning_output_tokens"] == 20
    assert "reasoning_content" not in record["handoff_message"]
    if strategy == "llm_inline":
        assert record["handoff_message"]["content"] == content
    else:
        assert record["fallback_error"]["type"] == "ValueError"
        assert record["handoff_message"]["content"].startswith("Context compacted.")


@pytest.mark.asyncio
async def test_compaction_cancellation_does_not_commit_fallback() -> None:
    class CancelledClient:
        async def create(self, **kwargs):
            raise asyncio.CancelledError()

    session = FakeSession()
    ledger = []
    with pytest.raises(asyncio.CancelledError):
        await CompactionService(usage_recorder=ledger.append).compact_async(
            session, await session.load_messages(), CancelledClient(), reason="auto", phase="mid_turn",
        )
    assert session.records == []
    assert ledger == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status, strategy", [
    ("completed", "llm_inline"),
    ("incomplete", "deterministic_fallback"),
    ("failed", "deterministic_fallback"),
])
async def test_compaction_respects_responses_status_and_records_usage(status, strategy):
    from unittest.mock import AsyncMock
    from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient

    provider = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value={
        "status": status,
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "Summary text"}]}],
        "usage": {"input_tokens": 100, "output_tokens": 20},
    })))
    session = FakeSession()
    ledger = []
    record = await CompactionService(usage_recorder=ledger.append).compact_async(
        session, await session.load_messages(), OpenAIResponsesClient(provider, "test-model"),
    )
    assert record["strategy"] == strategy
    assert len(ledger) == 1
    assert record["usage"]["input_tokens"] == ledger[0]["input_tokens"] == 100
    assert record["usage"]["output_tokens"] == ledger[0]["output_tokens"] == 20
    if status != "completed":
        assert record["handoff_message"]["content"].startswith("Context compacted.")


@pytest.mark.asyncio
async def test_compaction_service_keeps_llm_handoff_when_usage_persist_fails() -> None:
    class UsageFailingSession(FakeSession):
        async def persist_sampling_usage(self, usage):
            raise RuntimeError("usage store unavailable")

    class SuccessfulClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="LLM compact handoff"))],
                usage=SimpleNamespace(prompt_tokens=100, completion_tokens=20, total_tokens=120),
            )

    with tempfile.TemporaryDirectory() as temp_dir:
        base = _set_plan_context(Path(temp_dir))
        session = UsageFailingSession()
        record = await CompactionService().compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
            reason="manual",
            phase="manual",
            context_stats={"context_window_tokens": 1000},
        )

    assert record["strategy"] == "llm_inline"
    assert record["handoff_message"]["content"] == "LLM compact handoff"
    assert record["usage"]["input_tokens"] == 100
    assert record["usage_persist_error"]["type"] == "RuntimeError"
    assert "fallback_error" not in record


@pytest.mark.asyncio
async def test_compaction_service_keeps_llm_handoff_with_bad_context_stats() -> None:
    class SuccessfulClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="LLM compact handoff"))],
                usage=SimpleNamespace(prompt_tokens=100, completion_tokens=20, total_tokens=120),
            )

    with tempfile.TemporaryDirectory() as temp_dir:
        base = _set_plan_context(Path(temp_dir))
        session = FakeSession()
        session.session_base_path = str(base)
        record = await CompactionService().compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
            reason="auto",
            phase="mid_turn",
            context_stats={"context_window_tokens": "bad"},
        )

    assert record["strategy"] == "llm_inline"
    assert record["handoff_message"]["content"] == "LLM compact handoff"
    assert record["usage"]["input_tokens"] == 100
    assert record["usage"]["context_window_tokens"] > 0
    assert "fallback_error" not in record


@pytest.mark.asyncio
async def test_compaction_service_appends_active_plan_snapshot_before_persist() -> None:
    class SuccessfulClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="LLM compact handoff"))])

    with tempfile.TemporaryDirectory() as temp_dir:
        base = _set_plan_context(Path(temp_dir), _active_plan())
        session = FakeSession()
        session.session_base_path = str(base)
        record = await CompactionService(
            plan_snapshot_provider=build_plan_snapshot,
        ).compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
        )
        persisted_content = session.records[-1]["handoff_message"]["content"]

        assert record["handoff_message"]["content"] == persisted_content
        assert persisted_content.startswith("LLM compact handoff")
        assert "Plan state at compact boundary:" in persisted_content
        assert "Active plan:" in persisted_content
        assert "[completed] Inspect context builder" in persisted_content
        assert "[in_progress] Append compact snapshot" in persisted_content
        assert "Progress: completed=1, in_progress=1, pending=1, cancelled=0" in persisted_content

        (base / "plan.json").write_text(
            json.dumps({"schema_version": "2.0", "plan": [{"step": "Changed later", "status": "pending"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        assert session.records[-1]["handoff_message"]["content"] == persisted_content


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plan",
    [
        {"schema_version": "2.0", "plan": []},
        {"schema_version": "1.1", "status": "active", "steps": []},
    ],
)
async def test_compaction_service_skips_plan_snapshot_without_active_plan(plan) -> None:
    class SuccessfulClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="LLM compact handoff"))])

    with tempfile.TemporaryDirectory() as temp_dir:
        base = _set_plan_context(Path(temp_dir), plan)
        session = FakeSession()
        session.session_base_path = str(base)
        record = await CompactionService(
            plan_snapshot_provider=build_plan_snapshot,
        ).compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
        )

    assert record["handoff_message"]["content"] == "LLM compact handoff"
    assert "Plan state at compact boundary:" not in record["handoff_message"]["content"]


@pytest.mark.asyncio
async def test_compaction_service_ignores_corrupt_plan_snapshot() -> None:
    class SuccessfulClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="LLM compact handoff"))])

    with tempfile.TemporaryDirectory() as temp_dir:
        base = _set_plan_context(Path(temp_dir), "{bad json")
        session = FakeSession()
        session.session_base_path = str(base)
        record = await CompactionService(
            plan_snapshot_provider=build_plan_snapshot,
        ).compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
        )

    assert record["handoff_message"]["content"] == "LLM compact handoff"
    assert "Plan state at compact boundary:" not in record["handoff_message"]["content"]


def main() -> int:
    test_compaction_service_uses_full_source_for_mid_turn()
    asyncio.run(test_compaction_service_falls_back_when_llm_compact_fails())
    asyncio.run(test_compaction_service_keeps_llm_handoff_when_usage_persist_fails())
    asyncio.run(test_compaction_service_keeps_llm_handoff_with_bad_context_stats())
    asyncio.run(test_compaction_service_appends_active_plan_snapshot_before_persist())
    asyncio.run(test_compaction_service_skips_plan_snapshot_without_active_plan())
    asyncio.run(test_compaction_service_ignores_corrupt_plan_snapshot())
    print("CompactionService tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
