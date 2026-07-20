"""Concurrent model-stream event pumping for turn execution."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from agent.application.ports.async_session_store import AsyncSessionStore
from agent.application.runtime.cancellation import CancellationToken
from agent.application.runtime.message_stream_parser import MessageStreamParser
from agent.application.services import attach_context_anchor, normalize_sampling_usage
from agent.application.services.context_estimator import DEFAULT_CONTEXT_WINDOW_TOKENS
from agent.domain import ParsedToolCall
from agent.domain.events import AssistantDeltaEvent, RuntimeEvent, TokenStatsUpdatedEvent, event_meta


@dataclass
class ModelStreamResult:
    content: str = ""
    tool_calls: list[ParsedToolCall] = field(default_factory=list)


async def pump_model_stream_events(
    *,
    stream_response: AsyncIterator[Any],
    stream_parser: MessageStreamParser,
    session: AsyncSessionStore,
    turn_id: str,
    cancellation_token: CancellationToken | None,
    context_stats: dict[str, Any],
    persist_sampling_usage: Callable[[AsyncSessionStore, dict], Awaitable[None]],
    result: ModelStreamResult,
) -> AsyncIterator[RuntimeEvent]:
    """Yield model delta/usage events while a background task consumes the stream."""
    event_queue: asyncio.Queue[RuntimeEvent | Exception | None] = asyncio.Queue()

    async def _consume() -> None:
        try:
            async def _on_content_async(text: str) -> None:
                await event_queue.put(AssistantDeltaEvent(**event_meta(session, turn_id), text=text))

            content, calls, usage = _normalize_parsed_stream_result(
                await stream_parser.consume_async_stream(stream_response, _on_content_async, cancellation_token)
            )
            result.content = content
            result.tool_calls = list(calls)

            normalized_usage = _normalize_usage(
                usage,
                context_stats,
                model=getattr(session, "model", None),
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
            except (asyncio.CancelledError, Exception):
                pass

    consume_task.result()


def _normalize_parsed_stream_result(parsed: Any) -> tuple[str, list[ParsedToolCall], Any | None]:
    if isinstance(parsed, tuple) and len(parsed) == 3:
        content, calls, usage = parsed
    else:
        content, calls = parsed
        usage = None
    return str(content or ""), list(calls or []), usage


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
