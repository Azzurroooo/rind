"""Manual maintenance must remain available after stopping an agent turn."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.application.context.compaction import CompactionService
from agent.runtime.server.worker import RuntimeWorker


@pytest.mark.asyncio
async def test_manual_compact_after_stop_keeps_automatic_continuations_suppressed(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    try:
        await worker.initialize()
        info = await worker.create_conversation({})
        session_id = info["session_id"]
        store = await worker.repository.open_store(session_id)
        await store.persist_message("user", "Keep the workspace choice.")
        await store.persist_message("assistant", "Understood.")
        provider = SimpleNamespace(close=AsyncMock())
        monkeypatch.setattr(worker.provider_service, "create_chat_client", AsyncMock(return_value=provider))
        compact = AsyncMock(return_value={"id": "compact-after-stop", "reason": "manual", "source": {}})
        monkeypatch.setattr(CompactionService, "compact_async", compact)
        continuation = AsyncMock()
        monkeypatch.setattr(worker.execution, "start_goal_continuation", continuation)
        events = []
        live_operations = []

        def capture(event):
            events.append(event)
            if event["type"] == "turn_started":
                live_operations.append(worker.execution.live_turn(session_id)["operation"])

        worker.execution.add_event_sink(capture)
        worker.execution.interrupt(session_id)
        result = await worker.execution.compact_context(session_id)
        assert result["id"] == "compact-after-stop"
        compact.assert_awaited_once()
        assert session_id in worker.execution._suppressed
        continuation.assert_not_awaited()
        assert any(event["type"] == "context_compacted" for event in events)
        assert events[-1]["type"] == "turn_completed"
        assert live_operations == ["compact"]
        assert not worker.execution.active_session_ids()
    finally:
        await worker.close()
