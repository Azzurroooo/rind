"""Asynchronous turn runner coordinating the turn lifecycle via event streams."""

from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator
import openai
from tenacity import RetryError

from agent.application.ports.async_session_store import AsyncSessionStore
from agent.application.ports.async_chat_client import AsyncChatClient
from agent.application.services import (
    CompactionService,
    ContextManager,
    validate_compact_handoff_boundary,
    validate_model_message_boundary,
)
from agent.application.runtime.cancellation import CancellationToken
from agent.application.runtime.model_stream_pump import ModelStreamResult, pump_model_stream_events
from agent.domain.events import (
    RuntimeEvent,
    AssistantDeltaEvent,
    AssistantMessageCompletedEvent,
    ContextBuiltEvent,
    SkillActivatedEvent,
    ToolRequestedEvent,
    TurnCompletedEvent,
    TurnFailedEvent,
    TurnCancelledEvent,
    event_meta,
)

from .message_stream_parser import MessageStreamParser
from agent.application.runtime.async_tool_call_processor import AsyncToolCallProcessor


def _compact_diagnostics(phase_detail: str | None) -> dict | None:
    if not phase_detail:
        return None
    return {"auto_compact_phase_detail": phase_detail}


class AsyncTurnRunner:
    """Manages the execution of a single conversational turn asynchronously."""

    def __init__(
        self,
        chat_client: AsyncChatClient,
        tool_processor: AsyncToolCallProcessor,
        stream_parser: MessageStreamParser,
        tool_schemas: list[dict],
        context_manager: ContextManager,
        debug: bool = False,
    ):
        self._chat_client = chat_client
        self._tool_processor = tool_processor
        self._stream_parser = stream_parser
        self._tool_schemas = tool_schemas
        self._context_manager = context_manager
        self._compaction_service = CompactionService()
        self._debug = debug

    def set_retry_callback(self, callback) -> None:
        """Set a callback invoked on LLM API retries: (attempt: int, exception: Exception) -> None."""
        if hasattr(self._chat_client, "on_retry"):
            self._chat_client.on_retry = callback

    def set_user_question_responder(self, responder) -> None:
        """Set the callback used when ask_user_question needs a user answer."""
        set_responder = getattr(self._tool_processor, "set_user_question_responder", None)
        if callable(set_responder):
            set_responder(responder)

    def set_model(self, model: str) -> bool:
        set_model = getattr(self._chat_client, "set_model", None)
        if not callable(set_model):
            return False
        set_model(model)
        return True

    async def run_turn(
        self,
        session: AsyncSessionStore,
        cancellation_token: CancellationToken | None = None,
        turn_id: str = "",
        transient_system_messages: list[dict] | None = None,
    ) -> AsyncIterator[RuntimeEvent]:
        """Run the main conversation loop for a user turn asynchronously, yielding events."""

        turn_started_at = time.perf_counter()
        original_hard_limit = self._snapshot_context_hard_limit()
        try:
            emitted_skill_names: set[str] = set()
            turn_active_skill_matches: list | None = None
            sampling_index = 0
            force_rescue_next_build = False
            context_length_recovery_count = 0
            while True:
                if cancellation_token and cancellation_token.is_cancelled:
                    yield self._cancelled_event(session, turn_id, cancellation_token)
                    return

                if turn_active_skill_matches is None:
                    turn_active_skill_matches = await self._resolve_turn_active_skills(session)

                context = await self._build_context(
                    session,
                    turn_active_skill_matches,
                    transient_system_messages=transient_system_messages,
                    allow_rescue=force_rescue_next_build,
                )
                force_rescue_next_build = False
                context_stats = context.stats if isinstance(getattr(context, "stats", None), dict) else {}
                context_decisions = context.decisions if isinstance(getattr(context, "decisions", None), dict) else {}
                context_messages = context.messages if isinstance(getattr(context, "messages", None), list) else []
                yield ContextBuiltEvent(
                    **event_meta(session, turn_id),
                    message_count=len(context_messages),
                    stats=dict(context_stats),
                    decisions=dict(context_decisions),
                )
                for item in context_decisions.get("active_skills") or []:
                    skill_name = str(item.get("name") or "")
                    skill_key = skill_name.lower()
                    if not skill_key or skill_key in emitted_skill_names:
                        continue
                    emitted_skill_names.add(skill_key)
                    yield SkillActivatedEvent(
                        **event_meta(session, turn_id),
                        skill_name=skill_name,
                        reason=str(item.get("reason") or ""),
                        score=int(item.get("score") or 0),
                        source=str(item.get("source") or ""),
                        path=str(item.get("path") or ""),
                    )

                compact_required = bool(context_decisions.get("compact_required"))
                if context_decisions.get("auto_compact_token_limit_reached") or compact_required:
                    context = await self._run_compact(
                        session=session,
                        context_messages=context_messages,
                        context_stats=context_stats,
                        reason="auto",
                        phase="mid_turn",
                        phase_detail=self._compact_phase_detail(sampling_index, compact_required),
                        active_skill_matches=turn_active_skill_matches,
                        transient_system_messages=transient_system_messages,
                        cancellation_token=cancellation_token,
                    )
                    context_stats = context.stats if isinstance(getattr(context, "stats", None), dict) else {}
                    context_decisions = context.decisions if isinstance(getattr(context, "decisions", None), dict) else {}
                    context_messages = context.messages if isinstance(getattr(context, "messages", None), list) else []
                    yield ContextBuiltEvent(
                        **event_meta(session, turn_id),
                        message_count=len(context_messages),
                        stats=dict(context_stats),
                        decisions=dict(context_decisions),
                    )

                boundary = validate_model_message_boundary(context_messages) if context_messages else None
                if boundary is not None and not boundary.ok:
                    raise RuntimeError(f"Invalid model message boundary: {boundary.reason}")

                try:
                    stream_response = self._chat_client.stream(
                        messages=context_messages,
                        tools=self._tool_schemas,
                        cancellation_token=cancellation_token
                    )

                    stream_result = ModelStreamResult()
                    async for event in pump_model_stream_events(
                        stream_response=stream_response,
                        stream_parser=self._stream_parser,
                        session=session,
                        turn_id=turn_id,
                        cancellation_token=cancellation_token,
                        context_stats=context_stats,
                        persist_sampling_usage=self._persist_sampling_usage,
                        result=stream_result,
                    ):
                        yield event

                    content_text = stream_result.content
                    parsed_tool_calls = stream_result.tool_calls

                    if content_text:
                        await session.persist_message("assistant", content_text)
                        yield AssistantMessageCompletedEvent(
                            **event_meta(session, turn_id),
                            content_chars=len(content_text),
                        )

                except openai.BadRequestError as e:
                    if "context_length_exceeded" in str(e) or "maximum context length" in str(e).lower():
                        context_length_recovery_count += 1
                        if context_length_recovery_count == 1:
                            await self._run_compact(
                                session=session,
                                context_messages=context_messages,
                                context_stats=context_stats,
                                reason="context_length_error",
                                phase="mid_turn",
                                phase_detail="context_length_recovery",
                                active_skill_matches=turn_active_skill_matches,
                                transient_system_messages=transient_system_messages,
                                cancellation_token=cancellation_token,
                            )
                        else:
                            self._context_manager.reduce_hard_limit(factor=0.8)
                            force_rescue_next_build = True
                        continue
                    raise
                except RetryError as e:
                    error_msg = f"\n\n[APIUnavailableError: The AI provider is currently unreachable after multiple retries. Error: {e.last_attempt.exception()}]"
                    yield AssistantDeltaEvent(**event_meta(session, turn_id), text=error_msg)
                    yield TurnFailedEvent(
                        **event_meta(session, turn_id),
                        error=error_msg,
                        error_type="RetryError",
                    )
                    return

                if not parsed_tool_calls:
                    break
                sampling_index += 1

                await session.persist_message(
                    "assistant",
                    "",
                    meta={"tool_calls": [{"id": item.call_id, "name": item.name} for item in parsed_tool_calls]},
                )

                for call in parsed_tool_calls:
                    yield ToolRequestedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call.call_id,
                        tool_name=call.name,
                        args_preview=call.raw_args[:500],
                    )

                async for event in self._tool_processor.execute(
                    session=session,
                    tool_calls=parsed_tool_calls,
                    cancellation_token=cancellation_token,
                    turn_id=turn_id,
                ):
                    yield event

            yield TurnCompletedEvent(
                **event_meta(session, turn_id),
                duration_ms=int((time.perf_counter() - turn_started_at) * 1000),
            )

        except asyncio.CancelledError as e:
            yield self._cancelled_event(session, turn_id, cancellation_token, fallback=str(e))
        except Exception as e:
            yield TurnFailedEvent(
                **event_meta(session, turn_id),
                error=str(e),
                error_type=type(e).__name__,
            )
        finally:
            self._restore_context_hard_limit(original_hard_limit)

    async def compact_context(
        self,
        session: AsyncSessionStore,
        reason: str = "manual",
        phase: str = "manual",
        cancellation_token: CancellationToken | None = None,
    ) -> dict:
        context = await self._build_context(session, active_skill_matches=None)
        stats = context.stats if isinstance(getattr(context, "stats", None), dict) else {}
        messages = context.messages if isinstance(getattr(context, "messages", None), list) else []
        record = await self._compaction_service.compact_async(
            session=session,
            context_messages=messages,
            chat_client=self._chat_client,
            reason=reason,
            phase=phase,
            context_stats=stats,
            cancellation_token=cancellation_token,
        )
        context = await self._build_context(session, active_skill_matches=None)
        self._validate_compact_context(context)
        return record

    async def _run_compact(
        self,
        *,
        session: AsyncSessionStore,
        context_messages: list[dict],
        context_stats: dict,
        reason: str,
        phase: str,
        phase_detail: str | None = None,
        active_skill_matches: list | None = None,
        transient_system_messages: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ):
        await self._compaction_service.compact_async(
            session=session,
            context_messages=context_messages,
            chat_client=self._chat_client,
            reason=reason,
            phase=phase,
            diagnostics=_compact_diagnostics(phase_detail),
            context_stats=context_stats,
            cancellation_token=cancellation_token,
        )
        context = await self._build_context(
            session,
            active_skill_matches=active_skill_matches,
            transient_system_messages=transient_system_messages,
        )
        self._validate_compact_context(context)
        return context

    async def _build_context(
        self,
        session: AsyncSessionStore,
        active_skill_matches: list | None,
        transient_system_messages: list[dict] | None = None,
        allow_rescue: bool = False,
    ):
        return await self._context_manager.build_messages_async(
            session=session,
            active_skill_matches=active_skill_matches,
            transient_system_messages=transient_system_messages,
            allow_rescue=allow_rescue,
        )

    async def _persist_sampling_usage(self, session: AsyncSessionStore, usage: dict) -> None:
        persist_usage = getattr(session, "persist_sampling_usage", None)
        if callable(persist_usage):
            await self._best_effort(persist_usage, usage)

    def _validate_compact_context(self, context) -> None:
        messages = context.messages if isinstance(getattr(context, "messages", None), list) else []
        result = validate_compact_handoff_boundary(messages)
        if not result.ok:
            raise RuntimeError(f"Compact produced an invalid continuation boundary: {result.reason}")

    def _has_valid_continuation_boundary(self, messages: list[dict]) -> bool:
        return validate_model_message_boundary(messages).ok

    async def _best_effort(self, operation, *args) -> None:
        try:
            await operation(*args)
        except Exception:
            pass

    def _compact_phase_detail(self, sampling_index: int, compact_required: bool) -> str | None:
        if compact_required:
            return "hard_limit"
        if sampling_index == 0:
            return "before_first_sampling"
        return None

    def _snapshot_context_hard_limit(self):
        snapshot = getattr(self._context_manager, "snapshot_hard_limit", None)
        if callable(snapshot):
            return snapshot()
        estimator = getattr(self._context_manager, "_estimator", None)
        budget = getattr(estimator, "budget", None)
        return getattr(budget, "hard_limit_tokens", None)

    def _restore_context_hard_limit(self, hard_limit) -> None:
        restore = getattr(self._context_manager, "restore_hard_limit", None)
        if callable(restore):
            restore(hard_limit)
            return
        estimator = getattr(self._context_manager, "_estimator", None)
        budget = getattr(estimator, "budget", None)
        if budget is not None and hasattr(budget, "hard_limit_tokens"):
            budget.hard_limit_tokens = hard_limit

    def _cancelled_event(
        self,
        session: AsyncSessionStore,
        turn_id: str,
        cancellation_token: CancellationToken | None,
        *,
        fallback: str = "",
    ) -> TurnCancelledEvent:
        reason = cancellation_token.reason if cancellation_token and cancellation_token.reason else fallback
        return TurnCancelledEvent(**event_meta(session, turn_id), reason=reason)

    async def _resolve_turn_active_skills(self, session: AsyncSessionStore) -> list:
        selector = getattr(self._context_manager, "select_active_skills_for_turn", None)
        if not callable(selector):
            return []
        user_message = await self._latest_user_content(session)
        try:
            return list(selector(user_message))
        except Exception:
            return []

    async def _latest_user_content(self, session: AsyncSessionStore) -> str:
        try:
            messages = await session.get_messages_slice()
        except Exception:
            return ""
        for message in reversed(messages):
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            content = message.get("content", "")
            return content if isinstance(content, str) else ""
        return ""
