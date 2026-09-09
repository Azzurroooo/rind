"""Usage ledger append/load plus the capture chain wiring."""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.context.manager import ContextBuildResult
from agent.application.context.token_usage import normalize_sampling_usage
from agent.infrastructure.persistence.usage_ledger import append_usage_record, load_usage_records
from agent.runtime.core.turn_runner import TurnRunner


def test_appended_records_read_back(tmp_path):
    path = tmp_path / "usage.jsonl"
    append_usage_record(path, {"session_id": "s1", "total_tokens": 10})
    append_usage_record(path, {"session_id": "s2", "total_tokens": 20})

    records = load_usage_records(path)

    assert [record["session_id"] for record in records] == ["s1", "s2"]
    assert [record["total_tokens"] for record in records] == [10, 20]


def test_concurrent_appends_never_interleave(tmp_path):
    path = tmp_path / "usage.jsonl"
    writers = 8
    per_writer = 25

    def _write(writer_index: int) -> None:
        for step in range(per_writer):
            append_usage_record(path, {"writer": writer_index, "step": step})

    threads = [threading.Thread(target=_write, args=(index,)) for index in range(writers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    records = load_usage_records(path)
    assert len(records) == writers * per_writer
    for record in records:
        assert set(record) == {"writer", "step"}


def _turn_with_capture(tmp_path, usage):
    """Run one sampling turn with a breakdown-bearing context and a real ledger recorder."""
    breakdowns = []

    class FakeSession:
        model = "test-model"
        session_id = "20260910_test"

        def __init__(self):
            self.usages = []

        async def get_turn_state(self):
            return None

        async def persist_turn_state(self, *args, **kwargs):
            return None

        def now_iso(self):
            return "2026-09-10T00:00:00Z"

        async def persist_message(self, *args, **kwargs):
            return None

        async def persist_sampling_usage(self, sampled):
            self.usages.append(dict(sampled))

        async def persist_context_breakdown(self, snapshot):
            breakdowns.append(snapshot)

    internal_messages = [
        {"role": "system", "content": "system prompt " * 10},
        {"role": "system", "content": "skills", "_context_kind": "skill_catalog"},
        {"role": "user", "content": "run the tool"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "ls"}},
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": "listing"},
    ]
    stripped = [
        {key: value for key, value in message.items() if not key.startswith("_")}
        for message in internal_messages
    ]
    stats = {"estimated_input_tokens": 150, "context_window_tokens": 4096}
    context = ContextBuildResult(
        messages=stripped,
        stats=stats,
        decisions={},
        internal_messages=internal_messages,
    )
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=context)
    mock_context.select_active_skills_for_turn = None

    mock_client = AsyncMock()

    class EmptyStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    mock_client.stream = MagicMock(return_value=EmptyStream())
    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("Done", [], usage, None, None))

    ledger_path = tmp_path / "usage.jsonl"

    def _recorder(record):
        append_usage_record(ledger_path, record)

    session = FakeSession()
    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
        usage_recorder=_recorder,
    )
    return runner, session, breakdowns, ledger_path


@pytest.mark.asyncio
async def test_turn_persists_breakdown_and_appends_measured_ledger_row(tmp_path):
    usage = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=25,
        total_tokens=125,
        prompt_tokens_details=SimpleNamespace(cached_tokens=40),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=5),
    )
    runner, session, breakdowns, ledger_path = _turn_with_capture(tmp_path, usage)

    events = [event async for event in runner.run_turn(session, turn_id="turn-9")]

    assert any(type(event).__name__ == "TurnCompletedEvent" for event in events)
    # The breakdown of the last build lands in session meta storage.
    assert len(breakdowns) == 1
    breakdown = breakdowns[0]
    assert breakdown["turn_id"] == "turn-9"
    assert breakdown["estimated_total"] == 150
    assert breakdown["context_window_tokens"] == 4096
    assert any(section["key"] == "skill_catalog" for section in breakdown["sections"])
    assert any(section["key"] == "tool:bash" for section in breakdown["sections"])
    # The ledger row mirrors the measured normalize_sampling_usage output shape.
    records = load_usage_records(ledger_path)
    assert len(records) == 1
    record = records[0]
    normalized = normalize_sampling_usage(
        usage,
        sampling_kind="assistant",
        context_window_tokens=4096,
    )
    for field, value in normalized.items():
        if field == "anchor":
            continue
        assert record[field] == value
    assert record["session_id"] == "20260910_test"
    assert record["model"] == "test-model"
    assert record["ts"]


@pytest.mark.asyncio
async def test_store_breakdown_overwrites_and_travels_with_fork(tmp_path):
    from agent.infrastructure.persistence import fork_session
    from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore

    store = JsonlSessionStore(
        session_dir=str(tmp_path),
        session_id="20260910_forkme",
        system_prompt="sys",
        workspace_root=str(tmp_path),
    )
    await store.initialize()
    await store.persist_message("user", "hello")
    await store.persist_context_breakdown({"turn_id": "first", "sections": []})
    await store.persist_context_breakdown({
        "turn_id": "second",
        "estimated_total": 42,
        "context_window_tokens": 100,
        "sections": [{"key": "chat_user", "label": "Chat · user inputs", "tokens": 42, "messages": 1}],
    })

    meta = JsonlSessionStore.load_session_metadata("20260910_forkme", str(tmp_path))
    # Overwrite = latest: meta holds the breakdown of the last assembled call.
    assert meta["latest_context_breakdown"]["turn_id"] == "second"

    forked = fork_session(tmp_path, "20260910_forkme")
    forked_meta = JsonlSessionStore.load_session_metadata(forked, str(tmp_path))
    assert forked_meta["latest_context_breakdown"]["estimated_total"] == 42
