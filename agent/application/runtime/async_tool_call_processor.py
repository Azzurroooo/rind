"""Asynchronous tool scheduler and execution layer."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import AsyncIterator, Any

from agent.application.ports.async_session_store import AsyncSessionStore
from agent.domain import ParsedToolCall, looks_like_tool_payload, parse_tool_args, tool_error, tool_ok
from agent.domain.events import (
    FileChangeEvent,
    RuntimeEvent,
    ToolCallStartedEvent,
    ToolResultEvent,
    UserQuestionRequestedEvent,
    event_meta,
)
from agent.application.tool_executor import ToolExecutor
from agent.application.runtime.cancellation import CancellationToken
from agent.application.services.tool_result_normalizer import ToolResultNormalizer

UserQuestionResponder = Callable[[UserQuestionRequestedEvent], str | Awaitable[str]]


@dataclass(slots=True)
class _ToolCallOutcome:
    status: str
    result: str
    error_type: str = ""


class AsyncToolCallProcessor:
    """Executes parsed tool calls and yields runtime events."""

    def __init__(
        self,
        tool_executor: ToolExecutor,
        tool_result_normalizer: ToolResultNormalizer | None = None,
        user_question_responder: UserQuestionResponder | None = None,
    ):
        self._tool_executor = tool_executor
        self._tool_result_normalizer = tool_result_normalizer or ToolResultNormalizer()
        self._user_question_responder = user_question_responder
        self._empty_bash_output_counts_by_turn: dict[str, dict[str, int]] = {}

    def set_user_question_responder(self, responder: UserQuestionResponder | None) -> None:
        """Set the callback used to collect answers for ask_user_question."""
        self._user_question_responder = responder

    async def execute(
        self,
        session: AsyncSessionStore,
        tool_calls: list[ParsedToolCall],
        cancellation_token: CancellationToken | None = None,
        turn_id: str = "",
    ) -> AsyncIterator[RuntimeEvent]:
        """
        Execute multiple tool calls asynchronously.
        Async tools (like bash) are awaited directly; sync tools run in a thread.
        """
        empty_bash_output_counts = self._counts_for_turn(turn_id)
        for call in tool_calls:
            if cancellation_token and cancellation_token.is_cancelled:
                break

            started_at = time.perf_counter()
            parsed_args, parse_error = parse_tool_args(call.raw_args)
            ts_start = session.now_iso()

            if parse_error:
                outcome = _ToolCallOutcome(
                    status="failed",
                    error_type="ToolArgsJSONError",
                    result=tool_error(
                        call.name,
                        f"Invalid tool arguments JSON: {parse_error}",
                        "ToolArgsJSONError",
                        meta={"raw_args": call.raw_args[:2000]},
                    ),
                )
            else:
                blocked_poll = self._empty_bash_output_pre_guard(call.name, parsed_args, empty_bash_output_counts)
                if blocked_poll:
                    outcome = _ToolCallOutcome(status="failed", error_type="RepeatedEmptyPoll", result=blocked_poll)
                else:
                    yield ToolCallStartedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call.call_id,
                        tool_name=call.name,
                    )
                    if call.name == "ask_user_question":
                        question_event = self._build_user_question_event(
                            session=session,
                            turn_id=turn_id,
                            call=call,
                            parsed_args=parsed_args,
                        )
                        yield question_event
                        outcome = await self._run_user_question(question_event)
                    else:
                        outcome = await self._run_tool_call(
                            call=call,
                            parsed_args=parsed_args,
                            cancellation_token=cancellation_token,
                            empty_bash_output_counts=empty_bash_output_counts,
                        )

            ts_end = session.now_iso()
            try:
                await self._persist_tool_result(
                    session=session,
                    call=call,
                    parsed_args=parsed_args,
                    ts_start=ts_start,
                    ts_end=ts_end,
                    tool_result_str=outcome.result,
                )
                persist_error = None
            except Exception as exc:
                persist_error = exc
                outcome = _ToolCallOutcome(
                    status="failed",
                    error_type=type(exc).__name__,
                    result=tool_error(call.name, f"Failed to persist tool result: {exc}", type(exc).__name__),
                )

            duration_ms = int((time.perf_counter() - started_at) * 1000)
            file_change_event = self._build_file_change_event(
                session=session,
                turn_id=turn_id,
                call=call,
                parsed_args=parsed_args,
                status=outcome.status,
                result=outcome.result,
            )
            if file_change_event is not None:
                yield file_change_event
            yield ToolResultEvent(
                **event_meta(session, turn_id),
                tool_call_id=call.call_id,
                tool_name=call.name,
                status=outcome.status,
                result=outcome.result,
                error_type=outcome.error_type,
                duration_ms=duration_ms,
            )
            if persist_error is not None:
                raise RuntimeError(f"Failed to persist tool result for {call.call_id}: {persist_error}") from persist_error

    async def _run_tool_call(
        self,
        *,
        call: ParsedToolCall,
        parsed_args: dict,
        cancellation_token: CancellationToken | None,
        empty_bash_output_counts: dict[str, int],
    ) -> _ToolCallOutcome:
        try:
            if self._tool_executor.is_async_tool(call.name):
                execution_args = {**parsed_args, "_cancellation_token": cancellation_token}
                result = await self._tool_executor.execute_async(call.name, execution_args, call.raw_args)
            else:
                execution_args = {**parsed_args, "_cancellation_token": cancellation_token}

                def _sync_run():
                    return self._tool_executor.execute_sync(call.name, execution_args, call.raw_args)

                result = await asyncio.to_thread(_sync_run)

            if result.status == "ok":
                tool_result_str = result.result_str
                if not looks_like_tool_payload(tool_result_str):
                    tool_result_str = tool_ok(call.name, tool_result_str)
                self._record_bash_output_observation(
                    call.name,
                    tool_result_str,
                    empty_bash_output_counts,
                )
                return _ToolCallOutcome(status="completed", result=tool_result_str)

            error_type = result.error_type or "ToolExecutionError"
            return _ToolCallOutcome(
                status="failed",
                error_type=error_type,
                result=tool_error(call.name, result.error_msg, error_type),
            )
        except Exception as exc:
            error_type = type(exc).__name__
            return _ToolCallOutcome(
                status="failed",
                error_type=error_type,
                result=tool_error(call.name, str(exc), error_type),
            )

    def _build_user_question_event(
        self,
        *,
        session: AsyncSessionStore,
        turn_id: str,
        call: ParsedToolCall,
        parsed_args: dict,
    ) -> UserQuestionRequestedEvent:
        options = self._clean_user_question_options(parsed_args.get("options"))
        recommended = self._clean_optional_text(parsed_args.get("recommended"))
        if recommended and options and recommended not in options:
            recommended = None
        return UserQuestionRequestedEvent(
            **event_meta(session, turn_id),
            tool_call_id=call.call_id,
            question=self._clean_required_text(parsed_args.get("question")),
            options=options,
            recommended=recommended,
        )

    async def _run_user_question(self, event: UserQuestionRequestedEvent) -> _ToolCallOutcome:
        if not event.question:
            return _ToolCallOutcome(
                status="failed",
                error_type="InvalidUserQuestion",
                result=tool_error(
                    "ask_user_question",
                    "ask_user_question requires a non-empty question string.",
                    "InvalidUserQuestion",
                ),
            )
        if self._user_question_responder is None:
            return _ToolCallOutcome(
                status="failed",
                error_type="UserQuestionUnsupported",
                result=tool_error(
                    "ask_user_question",
                    "No user-question responder is available in this execution environment.",
                    "UserQuestionUnsupported",
                ),
            )
        try:
            answer_value = self._user_question_responder(event)
            if isinstance(answer_value, Awaitable):
                answer_value = await answer_value
        except (KeyboardInterrupt, EOFError) as exc:
            return _ToolCallOutcome(
                status="failed",
                error_type=type(exc).__name__,
                result=tool_error(
                    "ask_user_question",
                    "User question input was interrupted.",
                    type(exc).__name__,
                ),
            )
        except Exception as exc:
            return _ToolCallOutcome(
                status="failed",
                error_type=type(exc).__name__,
                result=tool_error("ask_user_question", str(exc), type(exc).__name__),
            )

        answer = str(answer_value or "").strip()
        if not answer:
            return _ToolCallOutcome(
                status="failed",
                error_type="UserQuestionEmptyAnswer",
                result=tool_error(
                    "ask_user_question",
                    "User provided an empty answer.",
                    "UserQuestionEmptyAnswer",
                ),
            )
        return _ToolCallOutcome(
            status="completed",
            result=tool_ok("ask_user_question", {"answer": answer}),
        )

    def _clean_required_text(self, value: Any) -> str:
        if not isinstance(value, str):
            return ""
        return value.strip()

    def _clean_optional_text(self, value: Any) -> str | None:
        if value is None:
            return None
        text = self._clean_required_text(value)
        return text or None

    def _clean_user_question_options(self, value: Any) -> list[str] | None:
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        cleaned = [item.strip() for item in value if isinstance(item, str) and item.strip()]
        return cleaned or None

    async def _persist_tool_result(
        self,
        *,
        session: AsyncSessionStore,
        call: ParsedToolCall,
        parsed_args: dict,
        ts_start: str,
        ts_end: str,
        tool_result_str: str,
    ) -> None:
        normalized_result = self._tool_result_normalizer.normalize(tool_result_str)
        await session.persist_tool_call(
            call.call_id,
            call.name,
            dict(parsed_args),
            call.raw_args,
            ts_start,
            ts_end,
            tool_result_str,
            model_content=normalized_result.model_content,
            model_content_format=normalized_result.model_content_format,
            model_content_policy=normalized_result.model_content_policy,
            artifact_ref=normalized_result.artifact_ref,
        )
        await session.persist_message("tool", "", tool_call_id=call.call_id, tool_name=call.name)

    def _counts_for_turn(self, turn_id: str) -> dict[str, int]:
        if not turn_id:
            return {}
        key = turn_id or "__default__"
        if len(self._empty_bash_output_counts_by_turn) > 32:
            self._empty_bash_output_counts_by_turn.clear()
        return self._empty_bash_output_counts_by_turn.setdefault(key, {})

    def _empty_bash_output_pre_guard(
        self,
        tool_name: str,
        parsed_args: dict,
        counts: dict[str, int],
    ) -> str | None:
        if tool_name != "bash_output":
            return None
        bg_id = str(parsed_args.get("bg_id") or "")
        if not bg_id or counts.get(bg_id, 0) < 6:
            return None
        counts[bg_id] = counts.get(bg_id, 0) + 1
        return self._repeated_empty_poll_error(bg_id, counts[bg_id])

    def _record_bash_output_observation(
        self,
        tool_name: str,
        tool_result_str: str,
        counts: dict[str, int],
    ) -> None:
        if tool_name != "bash_output":
            return
        try:
            payload = json.loads(tool_result_str)
        except Exception:
            return
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return
        data = payload.get("data")
        if not isinstance(data, dict):
            return
        bg_id = str(data.get("bg_id") or "")
        if not bg_id:
            return
        empty_running = (
            data.get("status") == "running"
            and data.get("no_new_output") is True
            and not data.get("stdout")
            and not data.get("stderr")
        )
        if not empty_running:
            counts[bg_id] = 0
            return
        counts[bg_id] = counts.get(bg_id, 0) + 1

    def _repeated_empty_poll_error(self, bg_id: str, count: int) -> str:
        return tool_error(
            "bash_output",
            f"Background task {bg_id} is still running with no new output. Stop calling bash_output for this task now; return this bg_id to the user and tell them they can ask to check it again later.",
            "RepeatedEmptyPoll",
            meta={
                "bg_id": bg_id,
                "empty_observation_count": count,
                "suggested_next_wait_ms": self._suggested_wait_ms_for_empty_count(count),
            },
        )

    def _suggested_wait_ms_for_empty_count(self, count: int) -> int:
        if count <= 3:
            return 120000
        return 300000

    def _build_file_change_event(
        self,
        *,
        session: AsyncSessionStore,
        turn_id: str,
        call: ParsedToolCall,
        parsed_args: dict,
        status: str,
        result: str,
    ) -> FileChangeEvent | None:
        if status != "completed":
            return None
        try:
            payload = json.loads(result)
        except Exception:
            return None
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return None
        lines = self._file_change_lines(call.name, parsed_args)
        if not lines:
            return None
        return FileChangeEvent(
            **event_meta(session, turn_id),
            tool_call_id=call.call_id,
            file_path=str(parsed_args.get("file_path") or ""),
            lines=lines,
        )

    def _file_change_lines(self, tool_name: str, parsed_args: dict) -> list[dict[str, str]]:
        if tool_name == "write_file":
            return [{"kind": "added", "text": line} for line in self._split_change_lines(parsed_args.get("content"))]
        if tool_name == "edit_file":
            removed = [
                {"kind": "removed", "text": line}
                for line in self._split_change_lines(parsed_args.get("old_str"))
            ]
            added = [
                {"kind": "added", "text": line}
                for line in self._split_change_lines(parsed_args.get("new_str"))
            ]
            return removed + added
        return []

    def _split_change_lines(self, value: object) -> list[str]:
        if not isinstance(value, str) or not value:
            return []
        return value.splitlines()
