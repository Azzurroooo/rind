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

from agent.application.services import CompactionService
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT
from agent.infrastructure.plans.store import set_active_session_context


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


def _active_plan(title: str = "Refactor plan context", version: int = 7, status: str = "active") -> dict:
    return {
        "plan_id": "p1",
        "title": title,
        "goal": "Move plan state to compact handoff.",
        "status": status,
        "version": version,
        "steps": [
            {"step_id": "s1", "title": "Inspect context builder", "status": "completed", "order": 0},
            {"step_id": "s2", "title": "Append compact snapshot", "status": "in_progress", "order": 1},
            {"step_id": "s3", "title": "Update tests", "status": "pending", "order": 2},
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
    os.environ["AGENT_SESSION_ROOT"] = str(root)
    os.environ["AGENT_SESSION_ID"] = session_id
    set_active_session_context(str(root), session_id)
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


@pytest.mark.asyncio
async def test_compaction_service_falls_back_when_llm_compact_fails() -> None:
    class FailingClient:
        async def create(self, *args, **kwargs):
            raise RuntimeError("provider unavailable")

    with tempfile.TemporaryDirectory() as temp_dir:
        _set_plan_context(Path(temp_dir))
        session = FakeSession()
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
    assert session.records[-1]["source"]["message_start_index"] == 0


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
        _set_plan_context(Path(temp_dir))
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
        _set_plan_context(Path(temp_dir))
        session = FakeSession()
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
        record = await CompactionService().compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
        )
        persisted_content = session.records[-1]["handoff_message"]["content"]

        assert record["handoff_message"]["content"] == persisted_content
        assert persisted_content.startswith("LLM compact handoff")
        assert "Plan state at compact boundary:" in persisted_content
        assert "Active plan summary:" in persisted_content
        assert "Refactor plan context (version 7)" in persisted_content
        assert "Current focus: s2 - Append compact snapshot" in persisted_content

        (base / "plan.json").write_text(
            json.dumps(_active_plan(title="Changed later", version=8), ensure_ascii=False),
            encoding="utf-8",
        )
        assert session.records[-1]["handoff_message"]["content"] == persisted_content


@pytest.mark.asyncio
async def test_compaction_service_skips_plan_snapshot_without_active_plan() -> None:
    class SuccessfulClient:
        async def create(self, *args, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="LLM compact handoff"))])

    with tempfile.TemporaryDirectory() as temp_dir:
        _set_plan_context(Path(temp_dir), _active_plan(status="completed"))
        session = FakeSession()
        record = await CompactionService().compact_async(
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
        _set_plan_context(Path(temp_dir), "{bad json")
        session = FakeSession()
        record = await CompactionService().compact_async(
            session=session,
            context_messages=await session.load_messages(),
            chat_client=SuccessfulClient(),
        )

    assert record["handoff_message"]["content"] == "LLM compact handoff"
    assert "Plan state at compact boundary:" not in record["handoff_message"]["content"]


def main() -> int:
    import asyncio

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
