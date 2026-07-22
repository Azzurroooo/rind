import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.events import TurnStartedEvent
from agent.interfaces.api.routes_session import TurnRequest, run_turn


@pytest.mark.asyncio
async def test_run_turn_rejects_invalid_session_id_before_factory() -> None:
    def factory(session_id: str):
        raise AssertionError("Factory should not be called for invalid session ids.")

    with pytest.raises(HTTPException) as exc_info:
        await run_turn("../escape", TurnRequest(query="hello"), object(), factory=factory)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Invalid session id."


@pytest.mark.asyncio
async def test_run_turn_streams_versioned_event_envelope() -> None:
    class Request:
        async def is_disconnected(self):
            return False

    class Agent:
        async def initialize(self):
            return None

        async def run_turn(self, **_kwargs):
            yield TurnStartedEvent(
                ts="2026-01-01T00:00:00Z",
                session_id="s1",
                turn_id="t1",
                user_message_chars=5,
            )

    def sync_factory(session_id: str):
        assert session_id == "s1"
        return Agent()

    response = await run_turn("s1", TurnRequest(query="hello"), Request(), factory=sync_factory)
    chunks = [chunk async for chunk in response.body_iterator]
    assert len(chunks) == 1
    assert chunks[0]["event"] == "turn_started"
    event = json.loads(chunks[0]["data"])

    assert event["kind"] == "event"
    assert event["sequence"] == 1
    assert event["event_type"] == "turn_started"
    assert event["timestamp"] == "2026-01-01T00:00:00Z"
    assert event["session_id"] == "s1"
    assert event["turn_id"] == "t1"
