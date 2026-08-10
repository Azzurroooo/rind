import asyncio
import os
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime import AgentRuntime, InputQueueError, TurnRunner
from agent.domain import ParsedToolCall
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import (
    AssistantDeltaEvent,
    ToolResultEvent,
    TurnCancelledEvent,
    TurnCompletedEvent,
    TurnStartedEvent,
)


class RecordingSession:
    session_id = "session_1"
    model = "test-model"

    def __init__(self):
        self.messages = []
        self.turn_states = []

    async def initialize(self):
        return None

    async def persist_message(self, role, content, **kwargs):
        self.messages.append((role, content, kwargs))

    async def persist_turn_state(self, turn_id, status, ts):
        self.turn_states.append((turn_id, status, ts))

    async def get_messages_slice(self):
        return [
            {"role": role, "content": content, **kwargs}
            for role, content, kwargs in self.messages
        ]

    def now_iso(self):
        return "2026-07-22T00:00:00Z"


class CompletingRunner:
    def __init__(self):
        self.calls = []

    async def run_turn(self, session, cancellation_token=None, turn_id="", take_steering=None):
        self.calls.append(turn_id)
        yield AssistantDeltaEvent(turn_id=turn_id, text=f"sample-{len(self.calls)}")
        yield TurnCompletedEvent(turn_id=turn_id, duration_ms=1)


@pytest.mark.asyncio
async def test_runtime_switch_session_updates_model_and_clears_pending_inputs():
    class SwitchableSession(RecordingSession):
        def __init__(self):
            super().__init__()
            self.session_id = "session_1"
            self.model = "model-1"

        async def switch_session(self, session_id):
            self.session_id = session_id
            self.model = "model-2"
            return {
                "session_id": session_id,
                "model": self.model,
                "usage": {"context_usage_percent": 0.25},
            }

    class SwitchableRunner(CompletingRunner):
        def __init__(self):
            super().__init__()
            self.model = "model-1"

        def set_model(self, model):
            self.model = model

    session = SwitchableSession()
    runner = SwitchableRunner()
    runtime = AgentRuntime(runner, session)
    await runtime.initialize()
    runtime._steering_queue.append("old steering")
    runtime._follow_up_queue.append("old follow-up")

    result = await runtime.switch_session("session_2")

    assert result["session_id"] == "session_2"
    assert session.session_id == "session_2"
    assert runner.model == "model-2"
    assert runtime.input_queue_counts() == {"steering": 0, "follow_up": 0}


@pytest.mark.asyncio
async def test_runtime_switch_session_rejects_active_turn():
    runtime = AgentRuntime(CompletingRunner(), RecordingSession())
    stream = runtime.run_turn(query="active")
    await anext(stream)

    with pytest.raises(RuntimeError, match="turn is active"):
        await runtime.switch_session("session-2")

    await stream.aclose()


@pytest.mark.asyncio
async def test_runtime_create_session_updates_model_and_clears_pending_inputs():
    class NewSession(RecordingSession):
        async def create_session(self):
            self.session_id = "session_2"
            self.model = "model-2"
            return {"session_id": self.session_id, "model": self.model}

    class ModelRunner(CompletingRunner):
        def __init__(self):
            super().__init__()
            self.model = "model-1"

        def set_model(self, model):
            self.model = model

    session = NewSession()
    runner = ModelRunner()
    runtime = AgentRuntime(runner, session)
    await runtime.initialize()
    runtime._steering_queue.append("old steering")
    runtime._follow_up_queue.append("old follow-up")

    result = await runtime.create_session()

    assert result == {"session_id": "session_2", "model": "model-2"}
    assert runner.model == "model-2"
    assert runtime.input_queue_counts() == {"steering": 0, "follow_up": 0}


@pytest.mark.asyncio
async def test_runtime_input_queue_validation_and_independent_limits():
    runtime = AgentRuntime(CompletingRunner(), RecordingSession())

    with pytest.raises(InputQueueError) as inactive:
        runtime.submit_steering("not active")
    assert inactive.value.error_type == "TurnNotActive"

    stream = runtime.run_turn(query="initial")
    assert isinstance(await anext(stream), TurnStartedEvent)

    with pytest.raises(InputQueueError) as empty:
        runtime.submit_follow_up("   ")
    assert empty.value.error_type == "InvalidRequest"

    with pytest.raises(InputQueueError) as too_long:
        runtime.submit_steering("x" * 8_001)
    assert too_long.value.error_type == "InputTooLong"

    assert runtime.submit_steering("x" * 8_000) == {
        "accepted": True,
        "mode": "steering",
        "pending": 1,
    }
    with pytest.raises(InputQueueError) as steering_chars_full:
        runtime.submit_steering("one more character")
    assert steering_chars_full.value.error_type == "InputQueueFull"

    for index in range(1, 5):
        result = runtime.submit_follow_up(f"follow-{index}")
        assert result == {"accepted": True, "mode": "follow_up", "pending": index}
    with pytest.raises(InputQueueError) as follow_up_full:
        runtime.submit_follow_up("follow-5")
    assert follow_up_full.value.error_type == "InputQueueFull"
    assert runtime.input_queue_counts() == {"steering": 1, "follow_up": 4}

    await stream.aclose()
    assert runtime.input_queue_counts() == {"steering": 0, "follow_up": 0}


@pytest.mark.asyncio
async def test_runtime_delivers_follow_ups_fifo_with_one_terminal_event_and_turn_id():
    session = RecordingSession()
    runner = CompletingRunner()
    runtime = AgentRuntime(runner, session)
    stream = runtime.run_turn(query="initial")

    started = await anext(stream)
    runtime.submit_follow_up("first follow-up")
    runtime.submit_follow_up("second follow-up")
    events = [started, *[event async for event in stream]]

    assert [message[:2] for message in session.messages] == [
        ("user", "initial"),
        ("user", "first follow-up"),
        ("user", "second follow-up"),
    ]
    assert len(runner.calls) == 3
    assert set(runner.calls) == {started.turn_id}
    completed = [event for event in events if isinstance(event, TurnCompletedEvent)]
    assert len(completed) == 1
    assert completed[0].duration_ms == 3
    assert all(event.turn_id == started.turn_id for event in events)
    assert [state[1] for state in session.turn_states] == ["running", "completed"]


@pytest.mark.asyncio
async def test_runtime_cancellation_discards_unconsumed_inputs_without_persisting_them():
    class CancelledRunner:
        async def run_turn(self, session, cancellation_token=None, turn_id="", take_steering=None):
            assert cancellation_token.is_cancelled
            yield TurnCancelledEvent(turn_id=turn_id, reason=cancellation_token.reason)

    session = RecordingSession()
    source = CancellationTokenSource()
    runtime = AgentRuntime(CancelledRunner(), session)
    stream = runtime.run_turn(query="initial", cancellation_token=source.token)

    await anext(stream)
    runtime.submit_steering("discard steering")
    runtime.submit_follow_up("discard follow-up")
    source.cancel("User interrupted")
    events = [event async for event in stream]

    assert len(events) == 1
    assert isinstance(events[0], TurnCancelledEvent)
    assert session.messages == [("user", "initial", {})]
    assert runtime.input_queue_counts() == {"steering": 0, "follow_up": 0}


@pytest.mark.asyncio
async def test_turn_runner_injects_one_fifo_steering_after_tool_chain_per_sampling():
    order = []
    responses = deque(
        [
            (
                "Need a tool",
                [ParsedToolCall(call_id="call_1", name="bash", raw_args='{"command":"date"}')],
                None,
            ),
            ("Adjusted once", [], None),
            ("Adjusted twice", [], None),
        ]
    )

    class ChatClient:
        def stream(self, **_kwargs):
            order.append("sample")

            async def empty_stream():
                if False:
                    yield None

            return empty_stream()

    class Parser:
        async def consume_async_stream(self, _stream, on_content, _cancellation_token, *_callbacks):
            content, calls, usage = responses.popleft()
            await on_content(content)
            return content, calls, usage

    class ToolProcessor:
        async def execute(self, **kwargs):
            order.append("tool_started")
            assert not any(item[:2] == ("user", "redirect once") for item in session.messages)
            yield ToolResultEvent(
                tool_call_id="call_1",
                tool_name="bash",
                status="completed",
                turn_id=kwargs["turn_id"],
            )
            order.append("tool_finished")

    class ContextManager:
        async def build_messages_async(self, **_kwargs):
            return SimpleNamespace(messages=[], stats={}, decisions={})

    class OrderedSession(RecordingSession):
        async def persist_message(self, role, content, **kwargs):
            order.append(f"persist:{role}:{content}")
            await super().persist_message(role, content, **kwargs)

    session = OrderedSession()
    steering = deque(["redirect once", "redirect twice"])

    def take_steering():
        order.append("take_steering")
        return steering.popleft() if steering else None

    runner = TurnRunner(
        chat_client=ChatClient(),
        tool_processor=ToolProcessor(),
        stream_parser=Parser(),
        tool_schemas=[],
        context_manager=ContextManager(),
    )
    events = [event async for event in runner.run_turn(session, turn_id="turn_1", take_steering=take_steering)]

    assert order.index("tool_finished") < order.index("take_steering")
    assert order.index("take_steering") < order.index("persist:user:redirect once")
    assert [item[:2] for item in session.messages if item[0] == "user"] == [
        ("user", "redirect once"),
        ("user", "redirect twice"),
    ]
    assert order.count("sample") == 3
    assert order.count("take_steering") == 3
    assert len([event for event in events if isinstance(event, TurnCompletedEvent)]) == 1
