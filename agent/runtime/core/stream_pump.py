"""Concurrent model-stream event pumping for turn execution."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections import deque
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from agent.application.context.estimator import DEFAULT_CONTEXT_WINDOW_TOKENS
from agent.application.context.token_usage import attach_context_anchor, normalize_sampling_usage, positive_int
from agent.application.ports.session_store import SessionStore
from agent.runtime.core.stream_parser import MessageStreamParser
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
    finish_reason: str | None = None


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
    event_queue: deque[tuple[RuntimeEvent, int]] = deque()
    available = asyncio.Event()
    space_available = asyncio.Event()
    queued_bytes = 0

    async def emit(event: RuntimeEvent) -> None:
        nonlocal queued_bytes
        size = len(json.dumps(event.to_dict(), ensure_ascii=False).encode("utf-8"))
        if size > 1024 * 1024:
            raise ValueError("Model stream event exceeds the 1 MiB queue budget.")
        while len(event_queue) >= 256 or queued_bytes + size > 1024 * 1024:
            space_available.clear()
            await space_available.wait()
        event_queue.append((event, size))
        queued_bytes += size
        available.set()

    def take() -> RuntimeEvent:
        nonlocal queued_bytes
        event, size = event_queue.popleft()
        queued_bytes -= size
        space_available.set()
        return event

    async def _consume() -> None:
        try:
            async def _on_content_async(text: str) -> None:
                for start in range(0, len(text), 2048):
                    await emit(AssistantDeltaEvent(**event_meta(session, turn_id), text=text[start:start + 2048]))

            async def _on_tool_input_started_async(call_id: str, name: str) -> None:
                await emit(
                    ToolInputStartedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call_id,
                        tool_name=name,
                    )
                )

            async def _on_tool_input_delta_async(call_id: str, name: str, delta: str) -> None:
                for start in range(0, len(delta), 2048):
                    await emit(
                        ToolInputDeltaEvent(
                            **event_meta(session, turn_id),
                            tool_call_id=call_id,
                            tool_name=name,
                            delta=delta[start:start + 2048],
                        )
                    )

            async def _on_tool_input_ended_async(call_id: str, name: str) -> None:
                await emit(
                    ToolInputEndedEvent(
                        **event_meta(session, turn_id),
                        tool_call_id=call_id,
                        tool_name=name,
                    )
                )

            content, calls, usage, reasoning_content, finish_reason = await stream_parser.consume_async_stream(
                stream_response,
                _on_content_async,
                cancellation_token,
                _on_tool_input_started_async,
                _on_tool_input_delta_async,
                _on_tool_input_ended_async,
            )
            result.content = str(content or "")
            result.tool_calls = list(calls or [])
            result.reasoning_content = reasoning_content if isinstance(reasoning_content, str) else None
            result.finish_reason = str(finish_reason) if finish_reason is not None else None

            normalized_usage = _normalize_usage(
                usage,
                context_stats,
                model=_session_model(session) if usage is not None else None,
            )
            if normalized_usage:
                await persist_sampling_usage(session, normalized_usage)
                await emit(TokenStatsUpdatedEvent(**event_meta(session, turn_id), stats=normalized_usage))
        finally:
            failure = sys.exc_info()[1]
            close = getattr(stream_response, "aclose", None)
            if close:
                try:
                    await close()
                except Exception:
                    if failure is None:
                        raise
                    logger.debug("Failed to close interrupted model stream.", exc_info=True)

    consume_task = asyncio.create_task(_consume())
    consume_task.add_done_callback(lambda _: available.set())
    deregister = cancellation_token.register_callback(
        lambda: consume_task.cancel(cancellation_token.reason)
    ) if cancellation_token else None
    try:
        while True:
            if not event_queue:
                if consume_task.done():
                    consume_task.result()
                    break
                available.clear()
                await available.wait()
                continue
            event = take()
            if isinstance(event, AssistantDeltaEvent):
                parts = [event.text]
                text_bytes = len(event.text.encode("utf-8"))
                deadline = asyncio.get_running_loop().time() + 0.025
                while text_bytes < 8192:
                    if event_queue:
                        following = event_queue[0][0]
                        if not isinstance(following, AssistantDeltaEvent):
                            break
                        size = len(following.text.encode("utf-8"))
                        if text_bytes + size > 8192:
                            break
                        parts.append(take().text)
                        text_bytes += size
                    elif consume_task.done():
                        break
                    else:
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            break
                        available.clear()
                        try:
                            await asyncio.wait_for(available.wait(), remaining)
                        except TimeoutError:
                            break
                event.text = "".join(parts)
            yield event
    finally:
        if deregister:
            deregister()
        if not consume_task.done():
            consume_task.cancel()
        await asyncio.gather(consume_task, return_exceptions=True)


def _normalize_usage(usage: Any, context_stats: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    if usage is None:
        return {}
    normalized = normalize_sampling_usage(
        usage,
        sampling_kind="assistant",
        context_window_tokens=positive_int(
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
        compact_generation=positive_int(
            context_stats.get("auto_compact_compact_generation"),
            1,
        ),
    )



def _session_model(session: SessionStore) -> str:
    return session.model
