"""Asynchronous tool scheduler and execution layer."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import AsyncIterator, Any

from agent.application.ports.session_store import SessionStore
from agent.domain import (
    ParsedToolCall,
    PersistenceError,
    ToolEventStatus,
    parse_tool_args,
    tool_cancelled,
    tool_error,
    tool_ok,
)
from agent.domain.events import (
    RuntimeEvent,
    ToolCallStartedEvent,
    ToolProgressEvent,
    ToolResultEvent,
    UserQuestionRequestedEvent,
    event_meta,
)
from agent.application.tools.executor import ToolExecutor
from agent.application.tools.change_events import build_file_change_event
from agent.application.tools.polling_guard import BashOutputPollingGuard
from agent.application.tools.result_normalizer import NormalizedToolResult, ToolResultNormalizer
from agent.domain.cancellation import CancellationToken

UserQuestionResponder = Callable[[UserQuestionRequestedEvent], str | Awaitable[str]]
_HEARTBEAT_TOOLS = frozenset({"bash", "bash_output"})


@dataclass(slots=True)
class _ToolCallOutcome:
    status: ToolEventStatus
    result: str
    error_type: str = ""


class ToolCallProcessor:
    """Executes parsed tool calls and yields runtime events."""

    HEARTBEAT_INTERVAL = 10.0

    def __init__(
        self,
        tool_executor: ToolExecutor,
        tool_result_normalizer: ToolResultNormalizer | None = None,
        tool_output_store=None,
        user_question_responder: UserQuestionResponder | None = None,
    ):
        self._tool_executor = tool_executor
        self._tool_result_normalizer = tool_result_normalizer or ToolResultNormalizer()
        self._tool_output_store = tool_output_store
        self._user_question_responder = user_question_responder
        self._polling_guard = BashOutputPollingGuard()

    def set_user_question_responder(self, responder: UserQuestionResponder | None) -> None:
        """Set the callback used to collect answers for ask_user_question."""
        self._user_question_responder = responder

    async def execute(
        self,
        session: SessionStore,
        tool_calls: list[ParsedToolCall],
        cancellation_token: CancellationToken | None = None,
        turn_id: str = "",
    ) -> AsyncIterator[RuntimeEvent]:
        """
        Execute multiple tool calls asynchronously.
        Async tools (like bash) are awaited directly; sync tools run in a thread.
        """
        if self._can_run_delegates_in_parallel(tool_calls):
            async for event in self._execute_parallel_delegates(
                session=session,
                tool_calls=tool_calls,
                cancellation_token=cancellation_token,
                turn_id=turn_id,
            ):
                yield event
            return
        empty_bash_output_counts = self._polling_guard.counts_for_turn(turn_id)
        for call in tool_calls:
            if cancellation_token and cancellation_token.is_cancelled:
                break

            started_at = time.perf_counter()
            parsed_args, parse_error = parse_tool_args(call.raw_args)
            ts_start = session.now_iso()
            reused = False

            existing = await self._load_tool_record(session, call)
            if existing is not None:
                parsed_args = existing.get("args") if isinstance(existing.get("args"), dict) else parsed_args
                outcome = self._outcome_from_record(existing)
                reused = True
            elif parse_error:
                outcome = _ToolCallOutcome(
                    status="rejected",
                    error_type="ToolArgsJSONError",
                    result=tool_error(
                        call.name,
                        f"Invalid tool arguments JSON: {parse_error}",
                        "ToolArgsJSONError",
                        meta={"raw_args": call.raw_args[:2000]},
                    ),
                )
            else:
                blocked_poll = self._polling_guard.pre_guard(call.name, parsed_args, empty_bash_output_counts)
                if blocked_poll:
                    outcome = _ToolCallOutcome(status="rejected", error_type="RepeatedEmptyPoll", result=blocked_poll)
                else:
                    yield ToolCallStartedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call.call_id,
                        tool_name=call.name,
                    )
                    if call.name == "ask_user_question":
                        try:
                            question_event = self._build_user_question_event(
                                session=session,
                                turn_id=turn_id,
                                call=call,
                                parsed_args=parsed_args,
                            )
                        except ValueError as exc:
                            outcome = _ToolCallOutcome(
                                status="rejected",
                                error_type="InvalidUserQuestion",
                                result=tool_error("ask_user_question", str(exc), "InvalidUserQuestion"),
                            )
                        else:
                            yield question_event
                            outcome = await self._run_user_question(question_event)
                    else:
                        tool_execution = self._run_tool_call(
                            call=call,
                            parsed_args=parsed_args,
                            session_id=session.session_id or "default",
                            cancellation_token=cancellation_token,
                            empty_bash_output_counts=empty_bash_output_counts,
                        )
                        if call.name not in _HEARTBEAT_TOOLS:
                            outcome = await tool_execution
                        else:
                            execution = asyncio.create_task(tool_execution)
                            try:
                                while not execution.done():
                                    done, _ = await asyncio.wait(
                                        [execution], timeout=self.HEARTBEAT_INTERVAL
                                    )
                                    if done:
                                        break
                                    elapsed_seconds = max(
                                        1, round(time.perf_counter() - started_at)
                                    )
                                    yield ToolProgressEvent(
                                        **event_meta(session, turn_id),
                                        tool_call_id=call.call_id,
                                        tool_name=call.name,
                                        payload={
                                            "message": f"still running ({elapsed_seconds}s)"
                                        },
                                    )
                                outcome = await execution
                            finally:
                                if not execution.done():
                                    execution.cancel()
                                    await asyncio.gather(execution, return_exceptions=True)

            ts_end = session.now_iso()
            normalized_result = await self._tool_result_normalizer.normalize(
                outcome.result,
                tool_name=call.name,
                status=outcome.status,
                error_type=outcome.error_type,
                output_store=self._tool_output_store,
                session_id=session.session_id or "",
                call_id=call.call_id,
            )
            try:
                if not reused:
                    await self._persist_tool_result(
                        session=session,
                        call=call,
                        parsed_args=parsed_args,
                        ts_start=ts_start,
                        ts_end=ts_end,
                        normalized_result=normalized_result,
                    )
                persist_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                persist_error = exc
                outcome = _ToolCallOutcome(
                    status="failed",
                    error_type="PersistenceError",
                    result=tool_error(call.name, f"Failed to persist tool result: {exc}", "PersistenceError"),
                )
                normalized_result = await self._tool_result_normalizer.normalize(
                    outcome.result,
                    tool_name=call.name,
                    status=outcome.status,
                    error_type=outcome.error_type,
                )

            duration_ms = int((time.perf_counter() - started_at) * 1000)
            file_change_event = None if reused else build_file_change_event(
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
                result=normalized_result.terminal_content,
                error_type=outcome.error_type,
                error_source="persistence" if persist_error is not None else "tool",
                duration_ms=duration_ms,
            )
            if persist_error is not None:
                raise PersistenceError(
                    f"Failed to persist tool result for {call.call_id}: {persist_error}",
                    code=type(persist_error).__name__,
                ) from persist_error

    def _can_run_delegates_in_parallel(self, tool_calls: list[ParsedToolCall]) -> bool:
        if len(tool_calls) < 2 or any(call.name != "delegate" for call in tool_calls):
            return False
        return all(parse_tool_args(call.raw_args)[1] is None for call in tool_calls)

    async def _execute_parallel_delegates(
        self,
        *,
        session: SessionStore,
        tool_calls: list[ParsedToolCall],
        cancellation_token: CancellationToken | None,
        turn_id: str,
    ) -> AsyncIterator[RuntimeEvent]:
        prepared: list[tuple[ParsedToolCall, dict, str, float]] = []
        for call in tool_calls:
            parsed_args, _ = parse_tool_args(call.raw_args)
            started_at = time.perf_counter()
            prepared.append((call, parsed_args, session.now_iso(), started_at))
            yield ToolCallStartedEvent(
                **event_meta(session, turn_id),
                tool_call_id=call.call_id,
                tool_name=call.name,
            )

        async def _run_or_reuse(call: ParsedToolCall, parsed_args: dict) -> tuple[_ToolCallOutcome, bool]:
            existing = await self._load_tool_record(session, call)
            if existing is not None:
                return self._outcome_from_record(existing), True
            return (
                await self._run_tool_call(
                    call=call,
                    parsed_args=parsed_args,
                    session_id=session.session_id or "default",
                    cancellation_token=cancellation_token,
                    empty_bash_output_counts={},
                ),
                False,
            )

        tasks = [
            asyncio.create_task(_run_or_reuse(call, parsed_args))
            for call, parsed_args, _, _ in prepared
        ]
        try:
            outcomes = await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

        for (call, parsed_args, ts_start, started_at), (outcome, reused) in zip(prepared, outcomes, strict=True):
            ts_end = session.now_iso()
            normalized_result = await self._tool_result_normalizer.normalize(
                outcome.result,
                tool_name=call.name,
                status=outcome.status,
                error_type=outcome.error_type,
                output_store=self._tool_output_store,
                session_id=session.session_id or "",
                call_id=call.call_id,
            )
            try:
                if not reused:
                    await self._persist_tool_result(
                        session=session,
                        call=call,
                        parsed_args=parsed_args,
                        ts_start=ts_start,
                        ts_end=ts_end,
                        normalized_result=normalized_result,
                    )
                persist_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                persist_error = exc
                outcome = _ToolCallOutcome(
                    status="failed",
                    error_type="PersistenceError",
                    result=tool_error("delegate", f"Failed to persist tool result: {exc}", "PersistenceError"),
                )
                normalized_result = await self._tool_result_normalizer.normalize(
                    outcome.result,
                    tool_name=call.name,
                    status=outcome.status,
                    error_type=outcome.error_type,
                )

            yield ToolResultEvent(
                **event_meta(session, turn_id),
                tool_call_id=call.call_id,
                tool_name=call.name,
                status=outcome.status,
                result=normalized_result.terminal_content,
                error_type=outcome.error_type,
                error_source="persistence" if persist_error is not None else "tool",
                duration_ms=int((time.perf_counter() - started_at) * 1000),
            )
            if persist_error is not None:
                raise PersistenceError(
                    f"Failed to persist tool result for {call.call_id}: {persist_error}",
                    code=type(persist_error).__name__,
                ) from persist_error

    async def _run_tool_call(
        self,
        *,
        call: ParsedToolCall,
        parsed_args: dict,
        session_id: str,
        cancellation_token: CancellationToken | None,
        empty_bash_output_counts: dict[str, int],
    ) -> _ToolCallOutcome:
        try:
            execution_args = {
                **parsed_args,
                "_session_id": session_id,
                "_cancellation_token": cancellation_token,
                "_idempotency_key": call.call_id,
                "_output_store": self._tool_output_store,
            }
            if self._tool_executor.is_async_tool(call.name):
                result = await self._tool_executor.execute_async(call.name, execution_args, call.raw_args)
            else:
                def _sync_run():
                    return self._tool_executor.execute_sync(call.name, execution_args, call.raw_args)

                result = await asyncio.to_thread(_sync_run)

            if result.status == "ok":
                tool_result_str = result.result_str
                payload = _load_tool_payload(tool_result_str)
                if payload is None:
                    tool_result_str = tool_ok(call.name, tool_result_str)
                payload_status = _classify_tool_payload(payload) if payload else None
                if payload_status:
                    return _ToolCallOutcome(
                        status=payload_status[0],
                        error_type=payload_status[1],
                        result=tool_result_str,
                    )
                self._polling_guard.record_observation(
                    call.name,
                    tool_result_str,
                    empty_bash_output_counts,
                )
                return _ToolCallOutcome(status="completed", result=tool_result_str)

            error_type = result.error_type or "ToolExecutionError"
            if result.status == "cancelled":
                return _ToolCallOutcome(
                    status="cancelled",
                    error_type=error_type,
                    result=result.result_str or tool_cancelled(call.name, result.error_msg),
                )
            return _ToolCallOutcome(
                status=result.failure_status or _classify_tool_error(error_type),
                error_type=error_type,
                result=tool_error(call.name, result.error_msg, error_type),
            )

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error_type = type(exc).__name__
            return _ToolCallOutcome(
                status="failed",
                error_type=error_type,
                result=tool_error(call.name, str(exc), error_type),
            )

    async def _load_tool_record(self, session: SessionStore, call: ParsedToolCall) -> dict[str, Any] | None:
        loader = getattr(session, "get_tool_records", None)
        if not callable(loader):
            return None
        records = await loader(call_ids=[call.call_id])
        if not isinstance(records, list):
            return None
        for record in reversed(records):
            if (
                isinstance(record, dict)
                and str(record.get("id") or "") == call.call_id
                and str(record.get("name") or "") == call.name
                and str(record.get("raw_args") or "") == call.raw_args
            ):
                return record
        return None

    def _outcome_from_record(self, record: dict[str, Any]) -> _ToolCallOutcome:
        error_type = str(record.get("error_type") or "")
        status = "completed" if record.get("ok") is True else _classify_tool_error(
            error_type or "ToolExecutionError"
        )
        return _ToolCallOutcome(
            status=status,
            error_type=error_type,
            result=str(record.get("model_content") or ""),
        )

    def _build_user_question_event(
        self,
        *,
        session: SessionStore,
        turn_id: str,
        call: ParsedToolCall,
        parsed_args: dict,
    ) -> UserQuestionRequestedEvent:
        question = self._clean_required_text(parsed_args.get("question"))
        if not question:
            raise ValueError("ask_user_question requires a non-empty question string.")
        if "recommended" in parsed_args:
            raise ValueError("ask_user_question no longer accepts a top-level recommended field.")
        options = self._clean_user_question_options(parsed_args.get("options"))
        return UserQuestionRequestedEvent(
            **event_meta(session, turn_id),
            tool_call_id=call.call_id,
            question=question,
            options=options,
        )

    async def _run_user_question(self, event: UserQuestionRequestedEvent) -> _ToolCallOutcome:
        if not event.question:
            return _ToolCallOutcome(
                status="rejected",
                error_type="InvalidUserQuestion",
                result=tool_error(
                    "ask_user_question",
                    "ask_user_question requires a non-empty question string.",
                    "InvalidUserQuestion",
                ),
            )
        if self._user_question_responder is None:
            return _ToolCallOutcome(
                status="unavailable",
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
                status="cancelled",
                error_type=type(exc).__name__,
                result=tool_error(
                    "ask_user_question",
                    "User question input was interrupted.",
                    type(exc).__name__,
                ),
            )
        except asyncio.CancelledError:
            raise
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

    def _clean_user_question_options(self, value: Any) -> list[dict[str, str]] | None:
        if value is None:
            return None
        if not isinstance(value, list) or not value:
            raise ValueError("ask_user_question options must be a non-empty array of option objects.")
        cleaned: list[dict[str, str]] = []
        labels: set[str] = set()
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise ValueError("Each ask_user_question option must be an object.")
            unknown = set(item) - {"label", "description"}
            if unknown:
                raise ValueError(f"ask_user_question options contain unsupported fields: {sorted(unknown)!r}.")
            label = item.get("label")
            description = item.get("description")
            if not isinstance(label, str) or not label.strip():
                raise ValueError("Each ask_user_question option requires a non-empty label.")
            if not isinstance(description, str) or not description.strip():
                raise ValueError("Each ask_user_question option requires a non-empty description.")
            label = label.strip()
            if label in labels:
                raise ValueError(f"ask_user_question option labels must be unique: {label!r}.")
            labels.add(label)
            has_recommended_suffix = label.endswith(" (Recommended)")
            if index == 0 and not has_recommended_suffix:
                raise ValueError('The first ask_user_question option label must end with " (Recommended)".')
            if index > 0 and has_recommended_suffix:
                raise ValueError('Only the first ask_user_question option may end with " (Recommended)".')
            cleaned.append({"label": label, "description": description.strip()})
        return cleaned

    async def _persist_tool_result(
        self,
        *,
        session: SessionStore,
        call: ParsedToolCall,
        parsed_args: dict,
        ts_start: str,
        ts_end: str,
        normalized_result: NormalizedToolResult,
    ) -> None:
        await session.persist_tool_call(
            call.call_id,
            call.name,
            dict(parsed_args),
            call.raw_args,
            ts_start,
            ts_end,
            normalized_result.persisted_content,
            model_content=normalized_result.model_content,
            model_content_format=normalized_result.model_content_format,
            model_content_policy=normalized_result.model_content_policy,
        )
        await session.persist_message("tool", "", tool_call_id=call.call_id, tool_name=call.name)


def _load_tool_payload(value: str) -> dict | None:
    if not value or not value.lstrip().startswith("{"):
        return None
    try:
        payload = json.loads(value)
    except (TypeError, ValueError):
        return None
    if isinstance(payload, dict) and "ok" in payload and "tool" in payload:
        return payload
    return None


def _classify_tool_payload(payload: dict) -> tuple[ToolEventStatus, str] | None:
    if payload.get("ok") is False:
        error_type = payload.get("error_type")
        if not isinstance(error_type, str) or not error_type:
            error_type = "ToolExecutionError"
        return _classify_tool_error(error_type), error_type
    data = payload.get("data")
    status = data.get("status") if isinstance(data, dict) else None
    if status == "cancelled":
        return "cancelled", "Cancelled"
    if status == "timed_out":
        return "timed_out", "Timeout"
    return None


def _classify_tool_error(error_type: str) -> ToolEventStatus:
    normalized = error_type.lower()
    if normalized == "cancelled":
        return "cancelled"
    if normalized in {"toolnotfound", "notfound", "userquestionunsupported"}:
        return "unavailable"
    if "timeout" in normalized or normalized in {"deadlineexceeded"}:
        return "timed_out"
    if normalized in {"toolargsjsonerror", "invaliduserquestion", "typeerror", "valueerror"}:
        return "rejected"
    return "failed"
