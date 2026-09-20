"""Deterministic compact/input boundaries; no live provider calls."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.application.context.manager import ContextBuildResult
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.errors import ProviderError
from agent.runtime.core import AgentRuntime, TurnRunner
from agent.domain import ParsedToolCall
from agent.domain.events import ToolResultEvent
from test_runtime_input_queues import RecordingSession


class CompactHarness:
    def __init__(self, *, auto=False, recovery=False, after_tools=False):
        self.session = RecordingSession()
        self.session.messages = [("user", "original task", {}), ("assistant", "old answer", {})]
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.requests = []
        self.compacted = False
        self.auto = auto
        self.recovery = recovery
        self.after_tools = after_tools
        self.tools_finished = False
        self.failure = None
        self.runner = TurnRunner(
            chat_client=self, stream_parser=self, tool_processor=self,
            tool_schemas=[], context_manager=self, compaction_service=self,
        )
        self.runtime = AgentRuntime(self.runner, self.session)

    def snapshot_hard_limit(self):
        return None

    async def build_messages_async(self, **_kwargs):
        messages = await self.session.get_messages_slice()
        for message in messages:
            if message.get("meta", {}).get("tool_calls"):
                message["tool_calls"] = [
                    {"id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": call["raw_args"]}}
                    for call in message["meta"]["tool_calls"]
                ]
        return ContextBuildResult(
            messages=messages, stats={},
            decisions={"auto_compact_token_limit_reached": self.auto and not self.compacted and (not self.after_tools or self.tools_finished)},
        )

    async def compact_async(self, **kwargs):
        self.started.set()
        await self.release.wait()
        token = kwargs.get("cancellation_token")
        if token and token.is_cancelled:
            raise asyncio.CancelledError(token.reason)
        if self.failure:
            raise self.failure
        self.compacted = True
        return {"id": "compact-1", "reason": kwargs["reason"], "source": {}}

    def stream(self, **kwargs):
        self.requests.append(kwargs["messages"])

        async def chunks():
            if self.recovery and not self.compacted:
                raise ProviderError("too long", code="context_length_exceeded")
            if False:
                yield None
        return chunks()

    async def consume_async_stream(self, stream, on_content, *_args):
        async for _ in stream:
            pass
        await on_content("answer")
        if self.after_tools and not self.tools_finished:
            return "answer", [ParsedToolCall(call_id="c1", name="read_file", raw_args='{"path":"notes"}')], None, None, None
        return "answer", [], None, None, None

    async def execute(self, **kwargs):
        await self.session.persist_message("tool", "notes", tool_call_id="c1")
        self.tools_finished = True
        yield ToolResultEvent(tool_call_id="c1", tool_name="read_file", status="completed", turn_id=kwargs["turn_id"])

    async def collect(self, **kwargs):
        return [event async for event in self.runtime.run_turn(**kwargs)]


@pytest.mark.asyncio
@pytest.mark.parametrize("inputs", [[], [("steering", "s1")], [("follow_up", "q1")],
                                   [("follow_up", "q1"), ("steering", "s1"), ("steering", "s2"), ("follow_up", "q2")]])
async def test_manual_compact_delivers_inputs_without_an_extra_sampling(inputs):
    h = CompactHarness()
    task = asyncio.create_task(h.collect(compact="manual"))
    await asyncio.wait_for(h.started.wait(), 2)
    assert h.runtime.turn_active
    assert h.session.turn_states == []
    accepted = {}
    for mode, text in inputs:
        submit = h.runtime.submit_steering if mode == "steering" else h.runtime.submit_follow_up
        accepted[text] = submit(text)["input_id"]
    h.release.set()
    events = await asyncio.wait_for(task, 2)
    expected = [text for mode, text in inputs if mode == "steering"] + [text for mode, text in inputs if mode == "follow_up"]
    delivered = [event for event in events if event.type == "queued_input_delivered"]
    assert [event.input for event in delivered] == expected
    assert [event.input_id for event in delivered] == [accepted[text] for text in expected]
    assert len(h.requests) == len(inputs)
    for request, text in zip(h.requests, expected):
        assert request[-1] == {"role": "user", "content": text}
    assert events[0].operation == "compact"
    assert events[-1].type == "turn_completed"
    assert sum(event.type == "turn_completed" for event in events) == 1
    assert not h.runtime.turn_active
    assert h.runtime.input_queue_counts() == {"steering": 0, "follow_up": 0}
    if not inputs:
        assert h.session.turn_states == []


@pytest.mark.asyncio
async def test_manual_compact_retrieval_promotion_and_duplicate_rejection():
    h = CompactHarness()
    task = asyncio.create_task(h.collect(compact="manual"))
    await asyncio.wait_for(h.started.wait(), 2)
    removed = h.runtime.submit_steering("remove")
    assert h.runtime.unsteer(removed["input_id"])["input"] == "remove"
    removed = h.runtime.submit_follow_up("remove queue")
    assert h.runtime.dequeue_follow_up(removed["input_id"])["input"] == "remove queue"
    promoted = h.runtime.submit_follow_up("promoted")
    h.runtime.promote_follow_up(promoted["input_id"])
    with pytest.raises(RuntimeError, match="active"):
        await h.runtime.compact_context()
    h.release.set()
    events = await asyncio.wait_for(task, 2)
    delivered = [event for event in events if event.type == "queued_input_delivered"]
    assert [(event.input, event.mode) for event in delivered] == [("promoted", "steering")]
    assert len(h.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("auto", [False, True])
@pytest.mark.parametrize("cancel", [False, True])
async def test_compact_failure_or_cancel_releases_inputs_and_allows_next_turn(cancel, auto):
    h = CompactHarness(auto=auto)
    source = CancellationTokenSource()
    task = asyncio.create_task(h.collect(compact=None if auto else "manual", cancellation_token=source.token))
    await asyncio.wait_for(h.started.wait(), 2)
    h.runtime.submit_steering("must not run")
    h.runtime.submit_follow_up("must not run either")
    if cancel:
        source.cancel("test cancel")
    else:
        h.failure = RuntimeError("test compact failure")
    h.release.set()
    events = await asyncio.wait_for(task, 2)
    assert events[-1].type == ("turn_cancelled" if cancel else "turn_failed")
    assert not h.compacted
    assert not h.requests
    if not auto:
        assert not h.session.turn_states
    assert not h.runtime.turn_active
    assert h.runtime.input_queue_counts() == {"steering": 0, "follow_up": 0}
    h.auto = False
    assert (await h.collect(query="next turn"))[-1].type == "turn_completed"
    assert h.requests[-1][-1]["content"] == "next turn"


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery,after_tools", [(False, False), (True, False), (False, True)])
async def test_auto_compact_steering_reaches_immediate_sampling_and_queue_waits(recovery, after_tools):
    h = CompactHarness(auto=not recovery, recovery=recovery, after_tools=after_tools)
    task = asyncio.create_task(h.collect(query="current task"))
    await asyncio.wait_for(h.started.wait(), 2)
    h.runtime.submit_follow_up("later task")
    h.runtime.submit_steering("redirect now")
    h.release.set()
    events = await asyncio.wait_for(task, 2)
    requests = h.requests[1:] if recovery or after_tools else h.requests
    assert len(requests) == 2
    assert requests[0][-1]["content"] == "redirect now"
    assert "later task" not in str(requests[0])
    assert requests[1][-1]["content"] == "later task"
    delivered = [(event.input, event.mode) for event in events if event.type == "queued_input_delivered"]
    assert delivered == [("redirect now", "steering"), ("later task", "follow_up")]
    assert events[-1].type == "turn_completed"
    if after_tools:
        tool_index = next(index for index, message in enumerate(requests[0]) if message["role"] == "tool")
        assert requests[0][tool_index - 1]["tool_calls"][0]["id"] == requests[0][tool_index]["tool_call_id"]
        assert tool_index < len(requests[0]) - 1


@pytest.mark.asyncio
async def test_input_submitted_at_compact_completion_is_not_cleared():
    h = CompactHarness()
    h.release.set()
    events = []
    async for event in h.runtime.run_turn(compact="manual"):
        events.append(event)
        if event.type == "context_compacted":
            h.runtime.submit_follow_up("at completion")
    assert h.requests[0][-1]["content"] == "at completion"
    assert events[-1].type == "turn_completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["rind/session/compact", "rind/command/execute"])
async def test_worker_compact_cancel_uses_active_token_and_releases_execution(tmp_path, monkeypatch, method):
    from agent.application.context.compaction import CompactionService
    from agent.runtime.server.worker import RuntimeWorker
    from agent.runtime.server.dispatcher import RuntimeDispatcher

    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
    info = await worker.initialize()
    session_id = info["session_id"]
    store = await worker.repository.open_store(session_id)
    await store.persist_message("user", "original task")
    await store.persist_message("assistant", "old answer")
    provider = SimpleNamespace(close=AsyncMock())
    monkeypatch.setattr(worker.provider_service, "create_chat_client", AsyncMock(return_value=provider))
    continuation = AsyncMock()
    monkeypatch.setattr(worker.execution, "start_goal_continuation", continuation)
    started = asyncio.Event()

    async def compact(_self, **kwargs):
        started.set()
        await kwargs["cancellation_token"].wait()
        raise asyncio.CancelledError("cancelled by user")

    monkeypatch.setattr(CompactionService, "compact_async", compact)
    messages = []

    async def send(message):
        messages.append(message)

    server = RuntimeDispatcher(worker, writer=SimpleNamespace(send=send))
    try:
        await server.dispatch({"request_id": "init", "method": "initialize", "params": {}})
        task = asyncio.create_task(server.dispatch({"request_id": "compact", "method": method, "params": {"session_id": session_id, "input": "/compact"}}))
        await asyncio.wait_for(started.wait(), 3)
        turn_id = worker.execution.active_turn_id(session_id)
        for control in ["rind/session/steer", "rind/session/follow_up"]:
            await server.dispatch({"request_id": control, "method": control, "params": {"session_id": session_id, "turn_id": turn_id, "input": "pending"}})
            assert messages[-1]["result"]["accepted"]
        await server.dispatch({"request_id": "cancel", "method": "session/cancel", "params": {"session_id": session_id, "turn_id": turn_id}})
        await asyncio.wait_for(task, 3)
        assert any(message.get("event", {}).get("type") == "turn_cancelled" for message in messages)
        assert not any(message.get("event", {}).get("type") == "context_compacted" for message in messages)
        assert not worker.execution.active_session_ids()
        assert (await store.get_turn_state()) is None
        continuation.assert_not_awaited()
        provider.close.assert_awaited_once()
    finally:
        server.close()
        await worker.close()
