"""FastAPI routes for session execution."""

from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.paths import validate_session_id
from agent.interfaces.api.dependencies import get_agent_factory
from agent.interfaces.runtime_server.protocol import event_envelope

router = APIRouter(prefix="/sessions", tags=["sessions"])

class TurnRequest(BaseModel):
    query: str
    system_prompt: str | None = None


@router.post("/{session_id}/turns")
async def run_turn(session_id: str, turn_req: TurnRequest, request: Request, factory=Depends(get_agent_factory)):
    """Run a single turn and stream the response events via SSE."""
    try:
        session_id = validate_session_id(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    agent = factory(session_id=session_id)
    await agent.initialize()
    cancel_source = CancellationTokenSource()

    async def event_generator():
        sequence = 0
        try:
            async for event in agent.run_turn(session_id=session_id, query=turn_req.query, cancellation_token=cancel_source.token):
                # Check for client disconnect
                if await request.is_disconnected():
                    cancel_source.cancel("Client disconnected")
                    break

                sequence += 1
                envelope = event_envelope(event.to_dict(), sequence)
                yield {"event": envelope["event_type"], "data": json.dumps(envelope, ensure_ascii=False)}
        except Exception as e:
            yield {
                "event": "error",
                "data": json.dumps({"error": str(e)}, ensure_ascii=False)
            }

    return EventSourceResponse(event_generator())
