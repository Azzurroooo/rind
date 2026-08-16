import pytest
import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace
import httpx
import openai
from tenacity import Future, RetryError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.core.runtime import AgentRuntime
from agent.runtime.core.turn_runner import TurnRunner
from agent.domain import ParsedToolCall
from agent.domain.events import (
    AssistantDeltaEvent,
    AssistantMessageCompletedEvent,
    ContextBuiltEvent,
    PlanUpdatedEvent,
    ToolInputDeltaEvent,
    ToolInputEndedEvent,
    ToolInputStartedEvent,
    ToolRequestedEvent,
    ToolResultEvent,
    TokenStatsUpdatedEvent,
    TurnStartedEvent,
    TurnCompletedEvent,
    TurnCancelledEvent,
    TurnFailedEvent
)
from agent.domain.cancellation import CancellationTokenSource
from agent.application import ContextBudget, ContextEstimator, ContextManager
from agent.application.context.estimator import DEFAULT_CONTEXT_WINDOW_TOKENS
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT

@pytest.mark.asyncio
async def test_async_turn_runner_cancellation():
    mock_client = AsyncMock()

    async def mock_stream(*args, **kwargs):
        yield MagicMock()
        await asyncio.sleep(0.1) # Simulate delay

    mock_client.stream = mock_stream

    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=MagicMock()
    )

    source = CancellationTokenSource()
    source.cancel("User cancelled")

    events = []
    async for event in runner.run_turn(MagicMock(), cancellation_token=source.token):
        events.append(event)

    assert len(events) == 1
    assert isinstance(events[0], TurnCancelledEvent)
    assert events[0].reason == "User cancelled"


@pytest.mark.asyncio
async def test_async_turn_runner_stream_cancelled_error_is_cancelled_event():
    mock_client = AsyncMock()

    async def mock_stream(*args, **kwargs):
        yield MagicMock()

    mock_client.stream = mock_stream

    mock_parser = MagicMock()

    async def mock_consume(*args, **kwargs):
        raise asyncio.CancelledError("stream cancelled")

    mock_parser.consume_async_stream = mock_consume

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], decisions={}))
    mock_context.select_active_skills_for_turn = None

    mock_session = MagicMock()
    mock_session.now_iso.return_value = "2026-05-08T00:00:00Z"

    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context
    )

    events = []
    async for event in runner.run_turn(mock_session):
        events.append(event)

    assert len(events) == 2
    assert isinstance(events[0], ContextBuiltEvent)
    assert isinstance(events[1], TurnCancelledEvent)
    assert events[1].reason == "stream cancelled"
    assert not any(isinstance(event, TurnFailedEvent) for event in events)


@pytest.mark.asyncio
async def test_async_turn_runner_cancelled_error_prefers_token_reason():
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()

    source = CancellationTokenSource()

    mock_parser = MagicMock()

    async def mock_consume(*args, **kwargs):
        source.cancel("User interrupted")
        raise asyncio.CancelledError()

    mock_parser.consume_async_stream = mock_consume

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None

    mock_session = MagicMock()
    mock_session.now_iso.return_value = "2026-05-08T00:00:00Z"

    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(mock_session, cancellation_token=source.token)]

    assert isinstance(events[-1], TurnCancelledEvent)
    assert events[-1].reason == "User interrupted"
    assert not any(isinstance(event, TurnFailedEvent) for event in events)


@pytest.mark.asyncio
async def test_async_runtime_facade_emits_turn_started_first():
    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.persisted = []

        async def initialize(self):
            return None

        async def persist_message(self, role, content, **kwargs):
            self.persisted.append((role, content, kwargs))

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    class FakeRunner:
        async def run_turn(self, session, cancellation_token=None, turn_id="", take_steering=None):
            yield TurnCompletedEvent(turn_id=turn_id)

    session = FakeSession()
    facade = AgentRuntime(turn_runner=FakeRunner(), session_store=session)

    events = [event async for event in facade.run_turn(query="hello")]

    assert isinstance(events[0], TurnStartedEvent)
    assert events[0].session_id == "session_1"
    assert events[0].user_message_chars == len("hello")
    assert events[0].turn_id
    assert events[1].turn_id == events[0].turn_id
    assert session.persisted == [("user", "hello", {})]


@pytest.mark.asyncio
async def test_async_runtime_holds_the_workspace_lock_for_the_entire_turn():
    events = []

    class FakeSession:
        session_id = "session_1"

        async def initialize(self):
            return None

        async def persist_message(self, role, content, **kwargs):
            return None

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    class TrackingLock:
        async def __aenter__(self):
            events.append("entered")
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            events.append("released")

    class FakeRunner:
        async def run_turn(self, session, cancellation_token=None, turn_id="", take_steering=None):
            assert events == ["entered"]
            events.append("running")
            yield TurnCompletedEvent(turn_id=turn_id)

    runtime = AgentRuntime(FakeRunner(), FakeSession(), workspace_lock=TrackingLock())

    completed = [event async for event in runtime.run_turn(query="hello")]

    assert isinstance(completed[-1], TurnCompletedEvent)
    assert events == ["entered", "running", "released"]


@pytest.mark.asyncio
async def test_async_runtime_persists_terminal_turn_state():
    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.states = []

        async def initialize(self):
            return None

        async def persist_message(self, role, content, **kwargs):
            return None

        async def persist_turn_state(self, turn_id, status, ts):
            self.states.append((turn_id, status, ts))

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    class FakeRunner:
        async def run_turn(self, session, cancellation_token=None, turn_id="", take_steering=None):
            yield TurnCompletedEvent(turn_id=turn_id, ts="2026-05-08T00:00:01Z")

    session = FakeSession()
    events = [
        event
        async for event in AgentRuntime(FakeRunner(), session).run_turn(query="hello")
    ]

    assert isinstance(events[-1], TurnCompletedEvent)
    assert session.states == [
        (events[0].turn_id, "running", events[0].ts),
        (events[-1].turn_id, "completed", "2026-05-08T00:00:01Z"),
    ]


@pytest.mark.asyncio
async def test_async_runtime_facade_passes_transient_system_messages():
    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.persisted = []

        async def initialize(self):
            return None

        async def persist_message(self, role, content, **kwargs):
            self.persisted.append((role, content, kwargs))

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    class FakeRunner:
        def __init__(self):
            self.received = None

        async def run_turn(self, session, cancellation_token=None, turn_id="", transient_system_messages=None, take_steering=None):
            self.received = transient_system_messages
            yield TurnCompletedEvent(turn_id=turn_id)

    prompt_messages = [{"role": "system", "content": "init prompt"}]
    runner = FakeRunner()
    session = FakeSession()
    facade = AgentRuntime(turn_runner=runner, session_store=session)

    events = [
        event
        async for event in facade.run_turn(
            query="Initialize project RIND.md",
            transient_system_messages=prompt_messages,
        )
    ]

    assert isinstance(events[0], TurnStartedEvent)
    assert runner.received == prompt_messages
    assert session.persisted == [("user", "Initialize project RIND.md", {})]


@pytest.mark.asyncio
async def test_async_runtime_continues_active_goal_until_terminal_status():
    class GoalSession:
        session_id = "goal-session"

        def __init__(self):
            self.goal = {"objective": "finish the release", "status": "active"}
            self.persisted = []

        async def initialize(self):
            return None

        async def persist_message(self, role, content, **kwargs):
            self.persisted.append((role, content, kwargs))

        async def persist_turn_state(self, turn_id, status, ts):
            return None

        async def get_goal(self):
            return dict(self.goal)

        async def set_goal_status(self, status):
            self.goal["status"] = status
            return dict(self.goal)

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    class GoalRunner:
        def __init__(self, session):
            self.session = session
            self.calls = []

        async def run_turn(self, session, transient_system_messages=None, **_kwargs):
            self.calls.append(transient_system_messages)
            if len(self.calls) == 2:
                await self.session.set_goal_status("complete")
            yield TurnCompletedEvent(turn_id="goal-turn")

    session = GoalSession()
    runner = GoalRunner(session)
    events = [
        event
        async for event in AgentRuntime(runner, session, goal_enabled=True).run_turn(query="start")
    ]

    assert len(runner.calls) == 2
    assert all(messages and "finish the release" in messages[-1]["content"] for messages in runner.calls)
    assert isinstance(events[-1], TurnCompletedEvent)
    assert session.goal["status"] == "complete"


@pytest.mark.asyncio
async def test_async_runtime_facade_initializes_session_once_for_concurrent_turns():
    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.initialize_calls = 0
            self.persisted = []

        async def initialize(self):
            self.initialize_calls += 1
            await asyncio.sleep(0)

        async def persist_message(self, role, content, **kwargs):
            self.persisted.append((role, content, kwargs))

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    class FakeRunner:
        async def run_turn(self, session, cancellation_token=None, turn_id="", take_steering=None):
            yield TurnCompletedEvent(turn_id=turn_id)

    session = FakeSession()
    facade = AgentRuntime(turn_runner=FakeRunner(), session_store=session)

    async def run_query(query: str):
        return [event async for event in facade.run_turn(query=query)]

    first_events, second_events = await asyncio.gather(run_query("first"), run_query("second"))

    assert session.initialize_calls == 1
    assert isinstance(first_events[0], TurnStartedEvent)
    assert isinstance(second_events[0], TurnStartedEvent)
    assert len(session.persisted) == 2


@pytest.mark.asyncio
async def test_async_runtime_initialization_binds_loaded_session_model():
    class FakeSession:
        model = "meta-model"

        async def initialize(self):
            return None

    class FakeRunner:
        def __init__(self):
            self.model = "settings-model"

        def set_model(self, model):
            self.model = model

    runner = FakeRunner()
    runtime = AgentRuntime(runner, FakeSession())

    await runtime.initialize()

    assert runner.model == "meta-model"


@pytest.mark.asyncio
async def test_async_runtime_facade_manual_compact_uses_runner():
    class FakeSession:
        async def initialize(self):
            return None

    class FakeRunner:
        def __init__(self):
            self.called = None

        async def compact_context(self, session, reason="manual", phase="manual", cancellation_token=None):
            self.called = (session, reason, phase, cancellation_token)
            return {"id": "compact_1"}

    session = FakeSession()
    runner = FakeRunner()
    facade = AgentRuntime(turn_runner=runner, session_store=session)

    record = await facade.compact_context(reason="manual")

    assert record == {"id": "compact_1"}
    assert runner.called == (session, "manual", "manual", None)


@pytest.mark.asyncio
async def test_async_runtime_facade_set_model_updates_runner_and_session():
    class FakeSession:
        def __init__(self):
            self.model = "old-model"

        async def initialize(self):
            return None

        async def update_model(self, model):
            self.model = model

    class FakeRunner:
        def __init__(self):
            self.model = "old-model"

        def set_model(self, model):
            self.model = model
            return True

    session = FakeSession()
    runner = FakeRunner()
    facade = AgentRuntime(turn_runner=runner, session_store=session)

    result = await facade.set_model("new-model")

    assert result == {"runtime": True, "session": True}
    assert runner.model == "new-model"
    assert session.model == "new-model"


@pytest.mark.asyncio
async def test_async_turn_runner_emits_tool_requested_before_tool_execution():
    mock_client = AsyncMock()

    async def mock_stream(*args, **kwargs):
        yield MagicMock()

    mock_client.stream = mock_stream

    calls = [
        ({"content": "Need tool", "calls": [ParsedToolCall(call_id="call_1", name="bash", raw_args='{"command":"date"}')]}),
        ({"content": "Done", "calls": []}),
    ]

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        on_tool_input_started_async = args[3]
        on_tool_input_delta_async = args[4]
        on_tool_input_ended_async = args[5]
        item = calls.pop(0)
        await on_content_async(item["content"])
        if item["calls"]:
            call = item["calls"][0]
            await on_tool_input_started_async(call.call_id, call.name)
            await on_tool_input_delta_async(call.call_id, call.name, call.raw_args)
            await on_tool_input_ended_async(call.call_id, call.name)
        return item["content"], item["calls"]

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.persisted = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def persist_message(self, *args, **kwargs):
            self.persisted.append((args, kwargs))

    async def execute(*args, **kwargs):
        yield ToolResultEvent(
            tool_call_id="call_1",
            tool_name="bash",
            status="completed",
            turn_id=kwargs.get("turn_id", ""),
        )

    mock_processor = MagicMock()
    mock_processor.execute = execute

    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=mock_processor,
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = []
    async for event in runner.run_turn(FakeSession(), turn_id="turn_1"):
        events.append(event)

    input_started_index = next(
        index for index, event in enumerate(events) if isinstance(event, ToolInputStartedEvent)
    )
    input_delta_index = next(
        index for index, event in enumerate(events) if isinstance(event, ToolInputDeltaEvent)
    )
    input_ended_index = next(
        index for index, event in enumerate(events) if isinstance(event, ToolInputEndedEvent)
    )
    requested_index = next(index for index, event in enumerate(events) if isinstance(event, ToolRequestedEvent))
    result_index = next(index for index, event in enumerate(events) if isinstance(event, ToolResultEvent))
    assert input_started_index < input_delta_index < input_ended_index < requested_index < result_index
    assert requested_index < result_index
    assert events[requested_index].args_preview == '{"command":"date"}'
    assert events[requested_index].arguments == {"command": "date"}
    assert events[requested_index].turn_id == "turn_1"


@pytest.mark.asyncio
async def test_async_turn_runner_emits_plan_snapshot_before_plan_execution():
    mock_client = AsyncMock()

    async def mock_stream(*_args, **_kwargs):
        yield MagicMock()

    mock_client.stream = mock_stream
    calls = [
        {"content": "Planning", "calls": [ParsedToolCall(call_id="plan_1", name="update_plan", raw_args='{"plan":[{"step":"Inspect","status":"in_progress"}]}')]},
        {"content": "Done", "calls": []},
    ]

    async def mock_consume(*args, **_kwargs):
        on_content_async = args[1]
        item = calls.pop(0)
        await on_content_async(item["content"])
        return item["content"], item["calls"]

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def persist_message(self, *_args, **_kwargs):
            return None

    async def execute(*_args, **kwargs):
        yield ToolResultEvent(tool_call_id="plan_1", tool_name="update_plan", status="completed", turn_id=kwargs.get("turn_id", ""))

    processor = MagicMock()
    processor.execute = execute
    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=processor,
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(FakeSession(), turn_id="turn_1")]
    requested_index = next(index for index, event in enumerate(events) if isinstance(event, ToolRequestedEvent))
    plan_index = next(index for index, event in enumerate(events) if isinstance(event, PlanUpdatedEvent))
    result_index = next(index for index, event in enumerate(events) if isinstance(event, ToolResultEvent))

    assert requested_index < plan_index < result_index
    assert events[plan_index].plan == [{"step": "Inspect", "status": "in_progress"}]


@pytest.mark.asyncio
async def test_async_turn_runner_passes_transient_system_messages_to_context():
    class EmptyStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    mock_client = AsyncMock()
    mock_client.stream = MagicMock(return_value=EmptyStream())
    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("", [], None))
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

    prompt_messages = [{"role": "system", "content": "init prompt"}]
    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [
        event
        async for event in runner.run_turn(
            FakeSession(),
            transient_system_messages=prompt_messages,
        )
    ]

    assert any(isinstance(event, TurnCompletedEvent) for event in events)
    assert mock_context.build_messages_async.call_args.kwargs["transient_system_messages"] == prompt_messages


@pytest.mark.asyncio
async def test_async_turn_runner_fails_after_tool_persist_failure():
    mock_client = AsyncMock()

    class EmptyStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    def mock_stream(*args, **kwargs):
        return EmptyStream()

    mock_client.stream = MagicMock(side_effect=mock_stream)

    call = ParsedToolCall(call_id="call_1", name="bash", raw_args='{"command":"date"}')

    async def mock_consume(*args, **kwargs):
        on_content_async = args[1]
        await on_content_async("Need tool")
        return "Need tool", [call]

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = mock_consume

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.persisted = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def persist_message(self, *args, **kwargs):
            self.persisted.append((args, kwargs))

    async def execute(*args, **kwargs):
        yield ToolResultEvent(
            tool_call_id="call_1",
            tool_name="bash",
            status="failed",
            error_type="OSError",
            result='{"ok":false}',
            turn_id=kwargs.get("turn_id", ""),
        )
        raise RuntimeError("Failed to persist tool result for call_1: disk full")

    mock_processor = MagicMock()
    mock_processor.execute = execute

    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=mock_processor,
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(FakeSession(), turn_id="turn_1")]

    tool_results = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(tool_results) == 1
    assert tool_results[0].status == "failed"
    assert tool_results[0].error_type == "OSError"
    assert isinstance(events[-1], TurnFailedEvent)
    assert events[-1].error_type == "RuntimeError"
    assert "Failed to persist tool result" in events[-1].error
    assert mock_client.stream.call_count == 1


@pytest.mark.asyncio
async def test_async_turn_runner_emits_and_persists_sampling_usage():
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()

    usage = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=25,
        total_tokens=125,
        prompt_tokens_details=SimpleNamespace(cached_tokens=40),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=5),
    )

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("Done", [], usage))

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(
        return_value=MagicMock(
            messages=[],
            stats={
                "context_window_tokens": DEFAULT_CONTEXT_WINDOW_TOKENS,
                "estimated_input_tokens": 180,
                "estimated_chars": 720,
                "message_count": 3,
                "auto_compact_compact_generation": 2,
            },
            decisions={},
        )
    )
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.usages = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def persist_message(self, *args, **kwargs):
            return None

        async def persist_sampling_usage(self, usage):
            self.usages.append(dict(usage))

    session = FakeSession()
    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(session)]
    token_event = next(event for event in events if isinstance(event, TokenStatsUpdatedEvent))

    assert token_event.stats["input_tokens"] == 100
    assert token_event.stats["cached_input_tokens"] == 40
    assert token_event.stats["cache_hit_rate"] == 0.4
    assert token_event.stats["context_usage_percent"] == 100 / DEFAULT_CONTEXT_WINDOW_TOKENS
    assert token_event.stats["anchor"]["local_estimated_input_tokens"] == 180
    assert token_event.stats["anchor"]["local_estimated_chars"] == 720
    assert token_event.stats["anchor"]["context_message_count"] == 3
    assert token_event.stats["anchor"]["compact_generation"] == 2
    assert session.usages[-1]["output_tokens"] == 25
    assert session.usages[-1]["anchor"]["local_estimated_input_tokens"] == 180


@pytest.mark.asyncio
async def test_async_turn_runner_usage_persistence_failure_does_not_fail_turn():
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()

    usage = SimpleNamespace(prompt_tokens=12, completion_tokens=3, total_tokens=15)
    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("Done", [], usage))

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(
        return_value=MagicMock(
            messages=[],
            stats={"context_window_tokens": 1000},
            decisions={},
        )
    )
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.messages = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def persist_message(self, *args, **kwargs):
            self.messages.append((args, kwargs))

        async def persist_sampling_usage(self, usage):
            raise OSError("meta write failed")

    session = FakeSession()
    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(session)]

    assert any(isinstance(event, TokenStatsUpdatedEvent) for event in events)
    assert any(isinstance(event, AssistantMessageCompletedEvent) for event in events)
    completed_event = next(event for event in events if isinstance(event, AssistantMessageCompletedEvent))
    assert completed_event.content == "Done"
    assert isinstance(events[-1], TurnCompletedEvent)
    assert not any(isinstance(event, TurnFailedEvent) for event in events)
    assert session.messages == [(("assistant", "Done"), {})]


@pytest.mark.asyncio
async def test_async_turn_runner_usage_tolerates_bad_context_stats():
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()

    usage = SimpleNamespace(prompt_tokens=12, completion_tokens=3, total_tokens=15)
    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("Done", [], usage))

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(
        return_value=MagicMock(
            messages=[],
            stats={"context_window_tokens": "bad"},
            decisions={},
        )
    )
    mock_context.select_active_skills_for_turn = None

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.usages = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def persist_message(self, *args, **kwargs):
            return None

        async def persist_sampling_usage(self, usage):
            self.usages.append(dict(usage))

    session = FakeSession()
    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(session)]

    token_event = next(event for event in events if isinstance(event, TokenStatsUpdatedEvent))
    assert token_event.stats["input_tokens"] == 12
    assert session.usages[-1]["context_window_tokens"] == DEFAULT_CONTEXT_WINDOW_TOKENS
    assert any(isinstance(event, AssistantMessageCompletedEvent) for event in events)
    assert not any(isinstance(event, TurnFailedEvent) for event in events)


@pytest.mark.asyncio
async def test_async_turn_runner_retry_error_emits_visible_failure():
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()

    failed_attempt = Future(1)
    failed_attempt.set_exception(RuntimeError("network down"))

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(side_effect=RetryError(failed_attempt))

    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=MagicMock(messages=[], stats={}, decisions={}))
    mock_context.select_active_skills_for_turn = None

    mock_session = MagicMock()
    mock_session.now_iso.return_value = "2026-05-08T00:00:00Z"

    runner = TurnRunner(
        chat_client=mock_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(mock_session)]

    assert any(
        isinstance(event, AssistantDeltaEvent) and "network down" in event.text
        for event in events
    )
    assert isinstance(events[-1], TurnFailedEvent)
    assert events[-1].error_type == "RetryError"
    assert "APIUnavailableError" in events[-1].error
    assert not any(event.error_type == "NameError" for event in events if isinstance(event, TurnFailedEvent))


@pytest.mark.asyncio
async def test_async_turn_runner_auto_compacts_before_sampling():
    class FakeChatClient:
        def __init__(self):
            self.created = 0
            self.streamed = 0

        async def create(self, messages, tools=None, cancellation_token=None):
            self.created += 1
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="LLM handoff"))],
                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            )

        def stream(self, *args, **kwargs):
            self.streamed += 1
            return EmptyStream()

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.compactions = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def load_messages(self):
            return [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}]

        async def get_tool_records(self, *args, **kwargs):
            return []

        async def get_latest_compaction(self):
            return None

        async def persist_compaction(self, record):
            self.compactions.append(dict(record))
            return dict(record)

        async def persist_sampling_usage(self, usage):
            return None

        async def persist_message(self, *args, **kwargs):
            return None

    first_context = MagicMock(
        messages=[{"role": "user", "content": "hello"}],
        stats={"context_window_tokens": 1000},
        decisions={"auto_compact_token_limit_reached": True},
    )
    second_context = MagicMock(
        messages=[
            {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
            {"role": "assistant", "content": "LLM handoff"},
        ],
        stats={
            "context_window_tokens": 1000,
            "estimated_input_tokens": 42,
        },
        decisions={},
    )
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(side_effect=[first_context, second_context])
    mock_context.select_active_skills_for_turn = None

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("", [], None))

    chat_client = FakeChatClient()
    session = FakeSession()
    runner = TurnRunner(
        chat_client=chat_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(session)]

    assert chat_client.created == 1
    assert chat_client.streamed == 1
    assert len(session.compactions) == 1
    assert session.compactions[0]["strategy"] == "llm_inline"
    assert session.compactions[0]["reason"] == "auto"
    assert session.compactions[0]["phase"] == "mid_turn"
    assert session.compactions[0]["diagnostics"]["auto_compact_phase_detail"] == "before_first_sampling"
    assert session.compactions[0]["handoff_message"]["content"] == "LLM handoff"
    assert sum(isinstance(event, ContextBuiltEvent) for event in events) == 2


@pytest.mark.asyncio
async def test_async_turn_runner_compacts_when_hard_limit_is_required():
    class EmptyStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class FakeChatClient:
        def __init__(self):
            self.created = 0
            self.streamed = 0

        async def create(self, messages, tools=None, cancellation_token=None):
            self.created += 1
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="LLM handoff"))],
            )

        def stream(self, *args, **kwargs):
            self.streamed += 1
            return EmptyStream()

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.compactions = []

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def load_messages(self):
            return [{"role": "user", "content": "hello"}]

        async def get_tool_records(self, *args, **kwargs):
            return []

        async def get_latest_compaction(self):
            return None

        async def persist_compaction(self, record):
            self.compactions.append(dict(record))
            return dict(record)

        async def persist_sampling_usage(self, usage):
            return None

        async def persist_message(self, *args, **kwargs):
            return None

    first_context = MagicMock(
        messages=[{"role": "user", "content": "hello"}],
        stats={"context_window_tokens": 1000},
        decisions={"compact_required": True, "auto_compact_token_limit_reached": False},
    )
    second_context = MagicMock(
        messages=[
            {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
            {"role": "assistant", "content": "LLM handoff"},
        ],
        stats={},
        decisions={},
    )
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(side_effect=[first_context, second_context])
    mock_context.select_active_skills_for_turn = None

    mock_parser = MagicMock()
    mock_parser.consume_async_stream = AsyncMock(return_value=("", [], None))

    chat_client = FakeChatClient()
    session = FakeSession()
    runner = TurnRunner(
        chat_client=chat_client,
        tool_processor=MagicMock(),
        stream_parser=mock_parser,
        tool_schemas=[],
        context_manager=mock_context,
    )

    events = [event async for event in runner.run_turn(session)]

    assert chat_client.created == 1
    assert chat_client.streamed == 1
    assert len(session.compactions) == 1
    assert session.compactions[0]["diagnostics"]["auto_compact_phase_detail"] == "hard_limit"
    assert sum(isinstance(event, ContextBuiltEvent) for event in events) == 2


@pytest.mark.asyncio
async def test_async_turn_runner_mid_turn_compact_does_not_preserve_raw_tail():
    class FakeChatClient:
        def __init__(self):
            self.prompt_messages = None

        async def create(self, messages, tools=None, cancellation_token=None):
            self.prompt_messages = messages
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="LLM handoff"))],
                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            )

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.compactions = []
            self.raw_messages = [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "old question"},
                {"role": "assistant", "content": "old answer"},
                {"role": "user", "content": "current question"},
                {"role": "assistant", "content": "", "meta": {"tool_calls": [{"id": "call_1", "name": "bash"}]}},
                {"role": "tool", "tool_call_id": "call_1", "content": ""},
            ]

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def load_messages(self):
            return [dict(message) for message in self.raw_messages]

        async def get_tool_records(self, *args, **kwargs):
            return [{"id": "call_1", "name": "bash", "raw_args": "{}", "model_content": "tool content"}]

        async def get_latest_compaction(self):
            return None

        async def persist_compaction(self, record):
            self.compactions.append(dict(record))
            return dict(record)

        async def persist_sampling_usage(self, usage):
            return None

    post_compact_context = MagicMock(
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
            {"role": "assistant", "content": "LLM handoff"},
        ],
        stats={"estimated_input_tokens": 64},
        decisions={},
    )
    mock_context = MagicMock()
    mock_context.build_messages_async = AsyncMock(return_value=post_compact_context)
    mock_context.select_active_skills_for_turn = None

    chat_client = FakeChatClient()
    session = FakeSession()
    runner = TurnRunner(
        chat_client=chat_client,
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=mock_context,
    )

    context = await runner._run_compact(
        session=session,
        context_messages=[dict(message) for message in session.raw_messages],
        context_stats={"context_window_tokens": 1000},
        reason="auto",
        phase="mid_turn",
    )

    prompt_text = str(chat_client.prompt_messages)
    record = session.compactions[0]
    assert set(record["source"]) == {
        "message_start_index",
        "message_end_index_exclusive",
        "tool_call_ids",
        "history_digest",
    }
    assert record["source"]["message_start_index"] == 0
    assert record["source"]["message_end_index_exclusive"] == len(session.raw_messages)
    assert record["source"]["tool_call_ids"] == ["call_1"]
    assert record["continuation_user_message"] == {
        "role": "user",
        "content": COMPACT_CONTINUATION_USER_CONTENT,
    }
    assert "current question" in prompt_text
    assert context.messages[-2] == {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT}
    assert context.messages[-1] == {"role": "assistant", "content": "LLM handoff"}
    assert {"role": "user", "content": "current question"} not in context.messages
    assert not any(message.get("role") == "tool" for message in context.messages)


def test_compact_continuation_boundary_rejects_system_assistant_only():
    runner = TurnRunner(
        chat_client=MagicMock(),
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=MagicMock(),
    )

    assert runner._has_valid_continuation_boundary(
        [
            {"role": "system", "content": "sys"},
            {"role": "assistant", "content": "Context compacted."},
        ]
    ) is False


def test_compact_continuation_boundary_accepts_user_assistant_handoff():
    runner = TurnRunner(
        chat_client=MagicMock(),
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=MagicMock(),
    )

    assert runner._has_valid_continuation_boundary(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
            {"role": "assistant", "content": "Context compacted."},
        ]
    ) is True


def test_model_boundary_rejects_naked_tool():
    runner = TurnRunner(
        chat_client=MagicMock(),
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=MagicMock(),
    )

    assert runner._has_valid_continuation_boundary(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
            {"role": "tool", "tool_call_id": "call_1", "content": "orphan"},
        ]
    ) is False


def test_model_boundary_rejects_incomplete_tool_call_tail():
    runner = TurnRunner(
        chat_client=MagicMock(),
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=MagicMock(),
    )

    assert runner._has_valid_continuation_boundary(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": "{}"},
                    }
                ],
            },
        ]
    ) is False


def test_model_boundary_accepts_completed_tool_call():
    runner = TurnRunner(
        chat_client=MagicMock(),
        tool_processor=MagicMock(),
        stream_parser=MagicMock(),
        tool_schemas=[],
        context_manager=MagicMock(),
    )

    assert runner._has_valid_continuation_boundary(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": "{}"},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "done"},
        ]
    ) is True


@pytest.mark.asyncio
async def test_context_length_recovery_hard_limit_is_turn_local():
    class LocalEmptyStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class FailingThenSuccessfulChatClient:
        def __init__(self):
            self.stream_calls = 0

        def stream(self, *args, **kwargs):
            self.stream_calls += 1
            if self.stream_calls <= 2:
                response = httpx.Response(400, request=httpx.Request("POST", "https://example.test"))
                raise openai.BadRequestError(
                    "context_length_exceeded",
                    response=response,
                    body={"error": {"code": "context_length_exceeded"}},
                )
            return LocalEmptyStream()

        async def create(self, messages, tools=None, cancellation_token=None):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="handoff"))])

    class FakeSession:
        session_id = "session_1"

        def __init__(self):
            self.compacted = False

        def now_iso(self):
            return "2026-05-08T00:00:00Z"

        async def get_messages_slice(self, *args, **kwargs):
            if self.compacted:
                return [
                    {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
                    {"role": "assistant", "content": "handoff"},
                ]
            return [{"role": "user", "content": "hello"}]

        async def load_messages(self):
            return [{"role": "user", "content": "hello"}]

        async def get_tool_records(self, *args, **kwargs):
            return []

        async def get_latest_compaction(self):
            return None

        async def persist_compaction(self, record):
            self.compacted = True
            return dict(record)

        async def persist_sampling_usage(self, usage):
            return None

        async def persist_message(self, *args, **kwargs):
            return None

    manager = ContextManager(
        estimator=ContextEstimator(
            ContextBudget(hard_limit_tokens=1000, context_window_tokens=2000)
        )
    )
    parser = MagicMock()
    parser.consume_async_stream = AsyncMock(return_value=("", [], None))
    runner = TurnRunner(
        chat_client=FailingThenSuccessfulChatClient(),
        tool_processor=MagicMock(),
        stream_parser=parser,
        tool_schemas=[],
        context_manager=manager,
    )

    events = [event async for event in runner.run_turn(FakeSession())]

    assert any(isinstance(event, TurnCompletedEvent) for event in events)
    assert manager._estimator.budget.hard_limit_tokens == 1000


def main() -> int:
    asyncio.run(test_async_turn_runner_cancellation())
    asyncio.run(test_async_turn_runner_stream_cancelled_error_is_cancelled_event())
    asyncio.run(test_async_turn_runner_cancelled_error_prefers_token_reason())
    asyncio.run(test_async_runtime_facade_emits_turn_started_first())
    asyncio.run(test_async_runtime_facade_passes_transient_system_messages())
    asyncio.run(test_async_runtime_facade_initializes_session_once_for_concurrent_turns())
    asyncio.run(test_async_runtime_facade_manual_compact_uses_runner())
    asyncio.run(test_async_runtime_facade_set_model_updates_runner_and_session())
    asyncio.run(test_async_turn_runner_emits_tool_requested_before_tool_execution())
    asyncio.run(test_async_turn_runner_passes_transient_system_messages_to_context())
    asyncio.run(test_async_turn_runner_fails_after_tool_persist_failure())
    asyncio.run(test_async_turn_runner_emits_and_persists_sampling_usage())
    asyncio.run(test_async_turn_runner_usage_persistence_failure_does_not_fail_turn())
    asyncio.run(test_async_turn_runner_usage_tolerates_bad_context_stats())
    asyncio.run(test_async_turn_runner_retry_error_emits_visible_failure())
    asyncio.run(test_async_turn_runner_auto_compacts_before_sampling())
    asyncio.run(test_async_turn_runner_compacts_when_hard_limit_is_required())
    asyncio.run(test_async_turn_runner_mid_turn_compact_does_not_preserve_raw_tail())
    test_compact_continuation_boundary_rejects_system_assistant_only()
    test_compact_continuation_boundary_accepts_user_assistant_handoff()
    test_model_boundary_rejects_naked_tool()
    test_model_boundary_rejects_incomplete_tool_call_tail()
    test_model_boundary_accepts_completed_tool_call()
    asyncio.run(test_context_length_recovery_hard_limit_is_turn_local())
    print("Async runtime tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
