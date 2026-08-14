"""Concurrent model-stream event pumping for turn execution."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from agent.application.context.estimator import DEFAULT_CONTEXT_WINDOW_TOKENS
from agent.application.context.token_usage import attach_context_anchor, normalize_sampling_usage
from agent.application.ports.session_store import SessionStore
from agent.application.runtime.stream_parser import MessageStreamParser
from agent.domain.cancellation import CancellationToken
from agent.domain import ParsedToolCall
from agent.domain.events import (
    AssistantDeltaEvent,
    RuntimeEvent,
    TokenStatsUpdatedEvent,
    ToolInputDeltaEvent,
    ToolInputEndedEvent,
    ToolInputStartedEvent,
    event_meta,
)


logger = logging.getLogger(__name__)


@dataclass
class ModelStreamResult:
    content: str = ""
    tool_calls: list[ParsedToolCall] = field(default_factory=list)
    reasoning_content: str | None = None


async def pump_model_stream_events(
    *,
    stream_response: AsyncIterator[Any],
    stream_parser: MessageStreamParser,
    session: SessionStore,
    turn_id: str,
    cancellation_token: CancellationToken | None,
    context_stats: dict[str, Any],
    persist_sampling_usage: Callable[[SessionStore, dict], Awaitable[None]],
    result: ModelStreamResult,
) -> AsyncIterator[RuntimeEvent]:
    """Yield model delta/usage events while a background task consumes the stream."""
    event_queue: asyncio.Queue[RuntimeEvent | Exception | None] = asyncio.Queue()

    async def _consume() -> None:
        try:
            async def _on_content_async(text: str) -> None:
                await event_queue.put(AssistantDeltaEvent(**event_meta(session, turn_id), text=text))

            async def _on_tool_input_started_async(call_id: str, name: str) -> None:
                await event_queue.put(
                    ToolInputStartedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call_id,
                        tool_name=name,
                    )
                )

            async def _on_tool_input_delta_async(call_id: str, name: str, delta: str) -> None:
                await event_queue.put(
                    ToolInputDeltaEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call_id,
                        tool_name=name,
                        delta=delta,
                    )
                )

            async def _on_tool_input_ended_async(call_id: str, name: str) -> None:
                await event_queue.put(
                    ToolInputEndedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call_id,
                        tool_name=name,
                    )
                )

            content, calls, usage, reasoning_content = _normalize_parsed_stream_result(
                await stream_parser.consume_async_stream(
                    stream_response,
                    _on_content_async,
                    cancellation_token,
                    _on_tool_input_started_async,
                    _on_tool_input_delta_async,
                    _on_tool_input_ended_async,
                )
            )
            result.content = content
            result.tool_calls = list(calls)
            result.reasoning_content = reasoning_content

            normalized_usage = _normalize_usage(
                usage,
                context_stats,
                model=_session_model(session) if usage is not None else None,
            )
            if normalized_usage:
                await persist_sampling_usage(session, normalized_usage)
                await event_queue.put(TokenStatsUpdatedEvent(**event_meta(session, turn_id), stats=normalized_usage))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await event_queue.put(exc)
        finally:
            try:
                await event_queue.put(None)
            except asyncio.CancelledError:
                event_queue.put_nowait(None)

    consume_task = asyncio.create_task(_consume())
    try:
        while True:
            event = await event_queue.get()
            if event is None:
                break
            if isinstance(event, Exception):
                raise event
            yield event
    finally:
        if not consume_task.done():
            consume_task.cancel()
            try:
                await consume_task
            except asyncio.CancelledError:
                logger.debug("Cancelled model stream consumer during cleanup.", exc_info=True)
            except Exception:
                logger.debug("Model stream consumer cleanup failed.", exc_info=True)

    consume_task.result()


def _normalize_parsed_stream_result(
    parsed: Any,
) -> tuple[str, list[ParsedToolCall], Any | None, str | None]:
    if isinstance(parsed, tuple) and len(parsed) == 4:
        content, calls, usage, reasoning_content = parsed
    elif isinstance(parsed, tuple) and len(parsed) == 3:
        content, calls, usage = parsed
        reasoning_content = None
    else:
        content, calls = parsed
        usage = None
        reasoning_content = None
    return str(content or ""), list(calls or []), usage, _normalize_reasoning_content(reasoning_content)


def _normalize_reasoning_content(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _normalize_usage(usage: Any, context_stats: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    if usage is None:
        return {}
    normalized = normalize_sampling_usage(
        usage,
        sampling_kind="assistant",
        context_window_tokens=_positive_int_or_default(
            context_stats.get("context_window_tokens"),
            DEFAULT_CONTEXT_WINDOW_TOKENS,
        ),
    )
    if not normalized:
        return {}
    return attach_context_anchor(
        normalized,
        context_stats=context_stats,
        model=model,
        compact_generation=_positive_int_or_default(
            context_stats.get("auto_compact_compact_generation"),
            1,
        ),
    )


def _positive_int_or_default(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _session_model(session: SessionStore) -> str | None:
    try:
        return session.model
    except AttributeError:
        return None
