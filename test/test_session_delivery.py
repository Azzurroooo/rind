"""A message delivered from outside a conversation runs as its next turn."""

import asyncio
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from agent.domain.models import ModelStreamEvent
from agent.runtime.server.worker import RuntimeWorker


class GatedClient:
    """Answers each request once its gate opens; records the last user message it was sent."""

    def __init__(self, seen: list[str], gate: asyncio.Event):
        self.seen = seen
        self.gate = gate

    async def stream(self, messages, **kwargs):
        self.seen.append(next(m["content"] for m in reversed(messages) if m["role"] == "user"))
        await self.gate.wait()
        yield ModelStreamEvent(kind="text_delta", text="Noted.")
        yield ModelStreamEvent(kind="completed", stop_reason="stop")

    async def close(self):
        pass


@pytest_asyncio.fixture
async def worker(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"), enable_goal=False)
    monkeypatch.setattr(worker.provider_service, "refresh_stale_models", AsyncMock())
    worker.seen, worker.gate = [], asyncio.Event()
    worker.gate.set()

    async def create(*args, **kwargs):
        return GatedClient(worker.seen, worker.gate)

    monkeypatch.setattr(worker.provider_service, "create_chat_client", create)
    await worker.initialize()
    worker.events = []
    worker.execution.add_event_sink(worker.events.append)
    yield worker
    await worker.close()


async def _saved_conversation(worker) -> str:
    session_id = (await worker.create_conversation({}))["session_id"]
    async for _ in worker.execution.run_turn(session_id, query="Start"):
        pass
    return session_id


async def _settled(worker, session_id: str, turns: int) -> None:
    for _ in range(300):
        done = [e for e in worker.events if e["type"] == "turn_completed" and e["session_id"] == session_id]
        if len(done) >= turns and session_id not in worker.execution._delivery_runs:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"expected {turns} delivered turns, saw {worker.events}")


@pytest.mark.asyncio
async def test_an_idle_conversation_runs_the_delivery_and_its_watchers_see_it(worker):
    session_id = await _saved_conversation(worker)
    worker.execution.deliver(session_id, "fe-ui delivered: 15 x 4 = 60")
    await _settled(worker, session_id, 1)
    assert worker.seen == ["Start", "fe-ui delivered: 15 x 4 = 60"]
    replay = await worker.repository.replay(session_id)
    assert [m["content"] for m in replay["messages"] if m["role"] == "user"][-1] == "fe-ui delivered: 15 x 4 = 60"


@pytest.mark.asyncio
async def test_deliveries_during_a_turn_wait_for_it_and_arrive_together(worker):
    session_id = await _saved_conversation(worker)
    worker.gate.clear()
    busy = asyncio.create_task(_drain(worker.execution.run_turn(session_id, query="Keep working")))
    while len(worker.seen) < 2:
        await asyncio.sleep(0.01)
    worker.execution.deliver(session_id, "first result")
    worker.execution.deliver(session_id, "second result")
    await asyncio.sleep(0.05)
    assert worker.seen == ["Start", "Keep working"], "the current turn is not interrupted"
    worker.gate.set()
    await busy
    await _settled(worker, session_id, 1)
    assert worker.seen[-1] == "first result\n\nsecond result"
    assert len(worker.seen) == 3


@pytest.mark.asyncio
async def test_a_delivery_runs_even_after_the_user_stopped_the_conversation(worker):
    session_id = await _saved_conversation(worker)
    worker.execution.interrupt(session_id)
    worker.execution.deliver(session_id, "the report is in")
    await _settled(worker, session_id, 1)
    assert worker.seen[-1] == "the report is in"


@pytest.mark.asyncio
async def test_a_closed_runtime_refuses_deliveries(worker):
    session_id = await _saved_conversation(worker)
    await worker.close()
    with pytest.raises(RuntimeError, match="closed"):
        worker.execution.deliver(session_id, "too late")


async def _drain(events):
    async for _ in events:
        pass


def test_the_protocol_queues_a_delivery_for_a_saved_conversation_only():
    from unittest.mock import Mock

    from helpers.fake_worker import FakeWorker, make_server
    from agent.runtime.server.protocol import RuntimeMethod

    worker = FakeWorker()
    worker.repository.exists = AsyncMock(side_effect=lambda session_id: session_id == "20260101_000000_aaaaaaaa")
    worker.execution.deliver = Mock()
    server, payloads = make_server(worker)

    def request(request_id, params):
        return {"kind": "request", "request_id": request_id, "method": RuntimeMethod.RIND_SESSION_DELIVER, "params": params}

    async def run():
        assert RuntimeMethod.RIND_SESSION_DELIVER in server._methods()
        await server._dispatch(request("ok", {"session_id": "20260101_000000_aaaaaaaa", "text": "results"}))
        await server._dispatch(request("missing", {"session_id": "20260101_000000_bbbbbbbb", "text": "results"}))
        await server._dispatch(request("empty", {"session_id": "20260101_000000_aaaaaaaa", "text": " "}))

    asyncio.run(run())
    responses = {p["request_id"]: p for p in payloads if p.get("request_id")}
    assert responses["ok"]["result"] == {"queued": True}
    assert responses["missing"]["error"]["type"] == "SessionNotFound"
    assert responses["empty"]["error"]["type"] == "InvalidParams"
    worker.execution.deliver.assert_called_once_with("20260101_000000_aaaaaaaa", "results")
