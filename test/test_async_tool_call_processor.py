import os
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pytest

from agent.application.runtime.async_tool_call_processor import AsyncToolCallProcessor
from agent.application.runtime.cancellation import CancellationTokenSource
from agent.domain import ParsedToolCall
from agent.domain.events import FileChangeEvent, ToolCallStartedEvent, ToolResultEvent, UserQuestionRequestedEvent
from agent.domain.tool_result import ToolExecutionResult


class FakeToolExecutor:
    def __init__(self):
        self.received_args = None

    def is_async_tool(self, name: str) -> bool:
        return True

    async def execute_async(self, name: str, args: dict, raw_args: str | None = None):
        self.received_args = dict(args)
        return ToolExecutionResult(status="ok", result_str="done")


class FakeSyncToolExecutor:
    def __init__(self):
        self.received_args = None

    def is_async_tool(self, name: str) -> bool:
        return False

    def execute_sync(self, name: str, args: dict, raw_args: str | None = None):
        self.received_args = dict(args)
        return ToolExecutionResult(status="ok", result_str="sync done")


class FakeFailingToolExecutor:
    def is_async_tool(self, name: str) -> bool:
        return True

    async def execute_async(self, name: str, args: dict, raw_args: str | None = None):
        return ToolExecutionResult(status="error", error_msg="failed", error_type="ToolFailed")


class FakeToolPayloadErrorExecutor:
    def is_async_tool(self, name: str) -> bool:
        return True

    async def execute_async(self, name: str, args: dict, raw_args: str | None = None):
        return ToolExecutionResult(
            status="ok",
            result_str='{"ok":false,"tool":"edit_file","error":"old_str not found","error_type":"OldStrNotFound"}',
        )


class FakeEmptyBashOutputExecutor:
    def __init__(self):
        self.calls = 0
        self.output_by_call: dict[int, str] = {}

    def is_async_tool(self, name: str) -> bool:
        return True

    async def execute_async(self, name: str, args: dict, raw_args: str | None = None):
        self.calls += 1
        stdout = self.output_by_call.get(self.calls, "")
        result = {
            "ok": True,
            "tool": "bash_output",
            "data": {
                "bg_id": args["bg_id"],
                "status": "running",
                "stdout": stdout,
                "stderr": "",
                "exit_code": -1,
                "delta": True,
                "no_new_output": stdout == "",
                "empty_observation_count": self.calls,
                "suggested_next_wait_ms": 15000,
            },
        }
        return ToolExecutionResult(status="ok", result_str=json.dumps(result))


class FakeSession:
    session_id = "session_1"

    def __init__(self):
        self.persisted_tool_calls = []
        self.persisted_messages = []

    def now_iso(self):
        return "2026-05-21T00:00:00Z"

    async def persist_tool_call(self, *args, **kwargs):
        self.persisted_tool_calls.append((args, kwargs))

    async def persist_message(self, *args, **kwargs):
        self.persisted_messages.append((args, kwargs))


class FailingToolCallPersistSession(FakeSession):
    async def persist_tool_call(self, *args, **kwargs):
        raise OSError("disk full")


class FailingToolMessagePersistSession(FakeSession):
    async def persist_message(self, *args, **kwargs):
        raise OSError("message write failed")


@pytest.mark.asyncio
async def test_bash_cancellation_token_is_not_persisted_in_tool_args() -> None:
    executor = FakeToolExecutor()
    session = FakeSession()
    processor = AsyncToolCallProcessor(tool_executor=executor)
    cancel_source = CancellationTokenSource()
    call = ParsedToolCall(
        call_id="call_1",
        name="bash",
        raw_args='{"command":"date"}',
    )

    events = [
        event
        async for event in processor.execute(
            session=session,
            tool_calls=[call],
            cancellation_token=cancel_source.token,
        )
    ]

    if "_cancellation_token" not in executor.received_args:
        raise AssertionError(f"Expected execution args to include cancellation token, got: {executor.received_args}")
    if not any(isinstance(event, ToolResultEvent) for event in events):
        raise AssertionError(f"Expected tool result event, got: {events}")
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if result_events[-1].status != "completed":
        raise AssertionError(f"Expected completed tool result, got: {result_events[-1]}")
    persisted_args = session.persisted_tool_calls[0][0][2]
    if persisted_args != {"command": "date"}:
        raise AssertionError(f"Expected clean persisted args, got: {persisted_args}")
    if not session.persisted_tool_calls[0][1].get("model_content"):
        raise AssertionError(f"Expected normalized model content, got: {session.persisted_tool_calls[0]}")


@pytest.mark.asyncio
async def test_sync_tool_receives_cancellation_token_without_persisting_private_args() -> None:
    executor = FakeSyncToolExecutor()
    session = FakeSession()
    processor = AsyncToolCallProcessor(tool_executor=executor)
    cancel_source = CancellationTokenSource()
    call = ParsedToolCall(call_id="call_sync", name="read_file", raw_args='{"file_path":"demo.txt"}')

    events = [
        event
        async for event in processor.execute(
            session=session,
            tool_calls=[call],
            cancellation_token=cancel_source.token,
        )
    ]

    if executor.received_args.get("_cancellation_token") is not cancel_source.token:
        raise AssertionError(f"Expected sync execution args to include cancellation token, got: {executor.received_args}")
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if len(result_events) != 1 or result_events[0].status != "completed":
        raise AssertionError(f"Expected completed sync tool result, got: {events}")
    persisted_args = session.persisted_tool_calls[0][0][2]
    if persisted_args != {"file_path": "demo.txt"}:
        raise AssertionError(f"Expected persisted args to exclude private token, got: {persisted_args}")


@pytest.mark.asyncio
async def test_invalid_tool_args_emit_failed_result_without_started_event() -> None:
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    session = FakeSession()
    call = ParsedToolCall(
        call_id="call_bad",
        name="bash",
        raw_args="{bad json",
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call], turn_id="turn_1")]

    if any(isinstance(event, ToolCallStartedEvent) for event in events):
        raise AssertionError(f"Did not expect started event for invalid args, got: {events}")

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if len(result_events) != 1:
        raise AssertionError(f"Expected one result event, got: {events}")
    result = result_events[0]
    if result.status != "failed" or result.error_type != "ToolArgsJSONError":
        raise AssertionError(f"Expected failed parse result, got: {result}")
    if result.turn_id != "turn_1":
        raise AssertionError(f"Expected turn_id to be propagated, got: {result.turn_id}")


@pytest.mark.asyncio
async def test_successful_tool_persists_result_directly() -> None:
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    session = FakeSession()
    call = ParsedToolCall(
        call_id="call_1",
        name="demo_tool",
        raw_args='{"value":"x"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call])]

    if not any(isinstance(event, ToolCallStartedEvent) for event in events):
        raise AssertionError(f"Expected started event, got: {events}")
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if len(result_events) != 1 or result_events[0].status != "completed":
        raise AssertionError(f"Expected completed result, got: {events}")
    if len(session.persisted_tool_calls) != 1:
        raise AssertionError("Expected tool call to be persisted directly")
    args, kwargs = session.persisted_tool_calls[0]
    persisted_result = args[-1]
    if '"ok": true' not in persisted_result or '"tool": "demo_tool"' not in persisted_result:
        raise AssertionError(f"Expected standardized tool payload, got: {persisted_result}")
    if kwargs.get("model_content_format") != "tool_result_v1":
        raise AssertionError(f"Expected model_content_format, got: {kwargs}")
    if kwargs.get("artifact_ref") is not None:
        raise AssertionError(f"Expected artifact_ref None, got: {kwargs}")


@pytest.mark.asyncio
async def test_write_file_success_emits_file_change_before_result() -> None:
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    session = FakeSession()
    call = ParsedToolCall(
        call_id="call_write",
        name="write_file",
        raw_args='{"file_path":"demo.txt","content":"one\\n\\ntwo\\n"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call], turn_id="turn_file")]

    if [type(event) for event in events] != [ToolCallStartedEvent, FileChangeEvent, ToolResultEvent]:
        raise AssertionError(f"Expected started/file_change/result events, got: {events}")
    file_change = events[1]
    if file_change.tool_call_id != "call_write" or file_change.file_path != "demo.txt":
        raise AssertionError(f"Expected file change identity from tool args, got: {file_change}")
    if file_change.lines != [
        {"kind": "added", "text": "one"},
        {"kind": "added", "text": ""},
        {"kind": "added", "text": "two"},
    ]:
        raise AssertionError(f"Expected write_file added lines from content, got: {file_change}")
    if len(session.persisted_tool_calls) != 1 or len(session.persisted_messages) != 1:
        raise AssertionError("Expected file change event to stay out of persistence")


@pytest.mark.asyncio
async def test_edit_file_success_emits_file_change_lines_from_args() -> None:
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    session = FakeSession()
    call = ParsedToolCall(
        call_id="call_edit",
        name="edit_file",
        raw_args='{"file_path":"demo.txt","old_str":"old\\ntext","new_str":"new\\ntext"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call])]

    file_changes = [event for event in events if isinstance(event, FileChangeEvent)]
    if len(file_changes) != 1:
        raise AssertionError(f"Expected one file_change event, got: {events}")
    file_change = file_changes[0]
    if file_change.lines != [
        {"kind": "removed", "text": "old"},
        {"kind": "removed", "text": "text"},
        {"kind": "added", "text": "new"},
        {"kind": "added", "text": "text"},
    ]:
        raise AssertionError(f"Expected edit_file removed then added lines, got: {file_change}")


@pytest.mark.asyncio
async def test_file_change_is_not_emitted_for_failed_empty_or_non_file_tools() -> None:
    session = FakeSession()
    failed_processor = AsyncToolCallProcessor(tool_executor=FakeFailingToolExecutor())
    failed_call = ParsedToolCall(
        call_id="call_failed",
        name="edit_file",
        raw_args='{"file_path":"demo.txt","old_str":"old","new_str":"new"}',
    )
    failed_events = [event async for event in failed_processor.execute(session=session, tool_calls=[failed_call])]
    if any(isinstance(event, FileChangeEvent) for event in failed_events):
        raise AssertionError(f"Did not expect file_change for failed edit_file, got: {failed_events}")

    payload_error_processor = AsyncToolCallProcessor(tool_executor=FakeToolPayloadErrorExecutor())
    payload_error_events = [
        event async for event in payload_error_processor.execute(session=FakeSession(), tool_calls=[failed_call])
    ]
    if any(isinstance(event, FileChangeEvent) for event in payload_error_events):
        raise AssertionError(f"Did not expect file_change for ok:false tool payload, got: {payload_error_events}")

    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    empty_call = ParsedToolCall(
        call_id="call_empty",
        name="write_file",
        raw_args='{"file_path":"empty.txt","content":""}',
    )
    non_file_call = ParsedToolCall(
        call_id="call_read",
        name="read_file",
        raw_args='{"file_path":"demo.txt"}',
    )
    events = [event async for event in processor.execute(session=FakeSession(), tool_calls=[empty_call, non_file_call])]
    if any(isinstance(event, FileChangeEvent) for event in events):
        raise AssertionError(f"Did not expect file_change for empty write or non-file tool, got: {events}")


@pytest.mark.asyncio
async def test_tool_result_event_reports_persist_failure() -> None:
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    session = FailingToolCallPersistSession()
    call = ParsedToolCall(
        call_id="call_1",
        name="demo_tool",
        raw_args='{"value":"x"}',
    )

    events = []
    with pytest.raises(RuntimeError, match="Failed to persist tool result"):
        async for event in processor.execute(session=session, tool_calls=[call], turn_id="turn_1"):
            events.append(event)

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if len(result_events) != 1:
        raise AssertionError(f"Expected one result event, got: {events}")
    result = result_events[0]
    payload = json.loads(result.result)
    if result.status != "failed" or result.error_type != "OSError":
        raise AssertionError(f"Expected failed persist result, got: {result}")
    if payload.get("ok") is not False or "Failed to persist tool result" not in payload.get("error", ""):
        raise AssertionError(f"Expected structured persist failure payload, got: {payload}")
    if session.persisted_messages:
        raise AssertionError(f"Did not expect tool message after persist failure, got: {session.persisted_messages}")


@pytest.mark.asyncio
async def test_tool_result_event_reports_tool_message_persist_failure() -> None:
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    session = FailingToolMessagePersistSession()
    call = ParsedToolCall(
        call_id="call_1",
        name="demo_tool",
        raw_args='{"value":"x"}',
    )

    events = []
    with pytest.raises(RuntimeError, match="Failed to persist tool result"):
        async for event in processor.execute(session=session, tool_calls=[call], turn_id="turn_1"):
            events.append(event)

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if len(result_events) != 1:
        raise AssertionError(f"Expected one result event, got: {events}")
    result = result_events[0]
    payload = json.loads(result.result)
    if result.status != "failed" or result.error_type != "OSError":
        raise AssertionError(f"Expected failed message persist result, got: {result}")
    if payload.get("ok") is not False or "Failed to persist tool result" not in payload.get("error", ""):
        raise AssertionError(f"Expected structured persist failure payload, got: {payload}")
    if len(session.persisted_tool_calls) != 1:
        raise AssertionError(f"Expected tool call record attempt to persist first, got: {session.persisted_tool_calls}")


@pytest.mark.asyncio
async def test_async_tool_processor_limits_repeated_empty_bash_output() -> None:
    executor = FakeEmptyBashOutputExecutor()
    processor = AsyncToolCallProcessor(tool_executor=executor)
    session = FakeSession()
    calls = [
        ParsedToolCall(call_id=f"call_{idx}", name="bash_output", raw_args='{"bg_id":"bg_123"}')
        for idx in range(7)
    ]

    events = [
        event
        async for event in processor.execute(
            session=session,
            tool_calls=calls,
            turn_id="turn_empty_guard",
        )
    ]

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if executor.calls != 6:
        raise AssertionError(f"Expected the 7th poll to be blocked before execution, got calls={executor.calls}")
    if len(result_events) != 7:
        raise AssertionError(f"Expected seven result events, got: {events}")
    blocked = json.loads(result_events[-1].result)
    if blocked.get("ok") is not False or blocked.get("error_type") != "RepeatedEmptyPoll":
        raise AssertionError(f"Expected RepeatedEmptyPoll error, got: {blocked}")
    meta = blocked.get("meta", {})
    if meta.get("empty_observation_count") != 7 or meta.get("suggested_next_wait_ms") != 300000:
        raise AssertionError(f"Expected 7th empty poll metadata with 300000ms wait, got: {blocked}")
    error = blocked.get("error", "")
    if "bg_123" not in error or "Stop calling bash_output" not in error or "user" not in error:
        raise AssertionError(f"Expected blocked poll to tell the model to stop and return bg_id, got: {blocked}")
    if result_events[-1].status != "failed":
        raise AssertionError(f"Expected failed result event for blocked poll, got: {result_events[-1]}")


@pytest.mark.asyncio
async def test_async_tool_processor_resets_empty_bash_output_count_on_real_output() -> None:
    executor = FakeEmptyBashOutputExecutor()
    executor.output_by_call[3] = "ready"
    processor = AsyncToolCallProcessor(tool_executor=executor)
    session = FakeSession()
    calls = [
        ParsedToolCall(call_id=f"call_{idx}", name="bash_output", raw_args='{"bg_id":"bg_reset"}')
        for idx in range(6)
    ]

    events = [
        event
        async for event in processor.execute(
            session=session,
            tool_calls=calls,
            turn_id="turn_empty_reset",
        )
    ]

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    if executor.calls != 6:
        raise AssertionError(f"Expected all polls to execute after real output reset, got calls={executor.calls}")
    if any(event.status == "failed" for event in result_events):
        raise AssertionError(f"Did not expect guard failure after count reset, got: {result_events}")


@pytest.mark.asyncio
async def test_ask_user_question_with_responder_emits_question_and_persists_answer() -> None:
    session = FakeSession()
    seen_questions = []

    async def responder(event: UserQuestionRequestedEvent) -> str:
        seen_questions.append(event)
        return "thorough"

    processor = AsyncToolCallProcessor(
        tool_executor=FakeToolExecutor(),
        user_question_responder=responder,
    )
    call = ParsedToolCall(
        call_id="call_question",
        name="ask_user_question",
        raw_args='{"question":"Which mode?","options":["fast","thorough"],"recommended":"thorough"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call], turn_id="turn_q")]

    if [type(event) for event in events] != [ToolCallStartedEvent, UserQuestionRequestedEvent, ToolResultEvent]:
        raise AssertionError(f"Expected started/question/result events, got: {events}")
    question_event = events[1]
    if question_event.question != "Which mode?" or question_event.options != ["fast", "thorough"]:
        raise AssertionError(f"Expected question event details, got: {question_event}")
    if question_event.recommended != "thorough":
        raise AssertionError(f"Expected recommended option, got: {question_event.recommended!r}")
    if seen_questions != [question_event]:
        raise AssertionError(f"Expected responder to receive question event, got: {seen_questions}")

    result_event = events[-1]
    payload = json.loads(result_event.result)
    if result_event.status != "completed" or payload.get("data", {}).get("answer") != "thorough":
        raise AssertionError(f"Expected completed answer payload, got: {result_event}")
    if len(session.persisted_tool_calls) != 1 or len(session.persisted_messages) != 1:
        raise AssertionError(
            f"Expected one persisted tool call and tool message, got: {session.persisted_tool_calls}, "
            f"{session.persisted_messages}"
        )
    persisted_args = session.persisted_tool_calls[0][0][2]
    if persisted_args != {
        "question": "Which mode?",
        "options": ["fast", "thorough"],
        "recommended": "thorough",
    }:
        raise AssertionError(f"Expected only model-provided args to persist, got: {persisted_args}")
    message_args, message_kwargs = session.persisted_messages[0]
    if message_args[0] != "tool" or message_kwargs.get("tool_call_id") != "call_question":
        raise AssertionError(f"Expected tool message persistence, got: {session.persisted_messages}")


@pytest.mark.asyncio
async def test_ask_user_question_without_responder_emits_question_then_unsupported_failure() -> None:
    session = FakeSession()
    processor = AsyncToolCallProcessor(tool_executor=FakeToolExecutor())
    call = ParsedToolCall(
        call_id="call_question",
        name="ask_user_question",
        raw_args='{"question":"Which mode?"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call])]

    if [type(event) for event in events] != [ToolCallStartedEvent, UserQuestionRequestedEvent, ToolResultEvent]:
        raise AssertionError(f"Expected started/question/result events, got: {events}")
    result_event = events[-1]
    payload = json.loads(result_event.result)
    if result_event.status != "failed" or result_event.error_type != "UserQuestionUnsupported":
        raise AssertionError(f"Expected unsupported failure event, got: {result_event}")
    if payload.get("ok") is not False or payload.get("error_type") != "UserQuestionUnsupported":
        raise AssertionError(f"Expected structured unsupported payload, got: {payload}")
    if len(session.persisted_tool_calls) != 1 or len(session.persisted_messages) != 1:
        raise AssertionError("Expected unsupported result to still persist as a tool result")


@pytest.mark.asyncio
async def test_ask_user_question_empty_answer_fails_without_fake_answer() -> None:
    session = FakeSession()
    processor = AsyncToolCallProcessor(
        tool_executor=FakeToolExecutor(),
        user_question_responder=lambda event: "  ",
    )
    call = ParsedToolCall(
        call_id="call_question",
        name="ask_user_question",
        raw_args='{"question":"Which mode?"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call])]

    result_event = [event for event in events if isinstance(event, ToolResultEvent)][-1]
    payload = json.loads(result_event.result)
    if result_event.status != "failed" or result_event.error_type != "UserQuestionEmptyAnswer":
        raise AssertionError(f"Expected empty-answer failure, got: {result_event}")
    if "answer" in payload.get("data", {}):
        raise AssertionError(f"Did not expect answer data in failure payload, got: {payload}")


@pytest.mark.asyncio
async def test_ask_user_question_interrupted_input_fails_without_cancelling_turn() -> None:
    session = FakeSession()

    def responder(event: UserQuestionRequestedEvent) -> str:
        raise KeyboardInterrupt

    processor = AsyncToolCallProcessor(
        tool_executor=FakeToolExecutor(),
        user_question_responder=responder,
    )
    call = ParsedToolCall(
        call_id="call_question",
        name="ask_user_question",
        raw_args='{"question":"Continue?"}',
    )

    events = [event async for event in processor.execute(session=session, tool_calls=[call])]

    result_event = [event for event in events if isinstance(event, ToolResultEvent)][-1]
    payload = json.loads(result_event.result)
    if result_event.status != "failed" or result_event.error_type != "KeyboardInterrupt":
        raise AssertionError(f"Expected interrupted-input failure, got: {result_event}")
    if payload.get("ok") is not False or payload.get("error_type") != "KeyboardInterrupt":
        raise AssertionError(f"Expected structured interrupted-input payload, got: {payload}")
    if len(session.persisted_tool_calls) != 1 or len(session.persisted_messages) != 1:
        raise AssertionError("Expected interrupted input to persist as a failed tool result")


def main() -> int:
    import asyncio

    asyncio.run(test_bash_cancellation_token_is_not_persisted_in_tool_args())
    asyncio.run(test_sync_tool_receives_cancellation_token_without_persisting_private_args())
    asyncio.run(test_invalid_tool_args_emit_failed_result_without_started_event())
    asyncio.run(test_successful_tool_persists_result_directly())
    asyncio.run(test_tool_result_event_reports_persist_failure())
    asyncio.run(test_tool_result_event_reports_tool_message_persist_failure())
    asyncio.run(test_async_tool_processor_limits_repeated_empty_bash_output())
    asyncio.run(test_async_tool_processor_resets_empty_bash_output_count_on_real_output())
    print("AsyncToolCallProcessor tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
