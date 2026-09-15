"""Accumulates provider-neutral stream events into one model result."""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, Callable

from agent.domain import ParsedToolCall
from agent.domain.cancellation import CancellationToken
from agent.domain.models import ModelStreamEvent, ModelUsage


class MessageStreamParser:
    """Accumulates provider-neutral stream events into one model result."""

    async def consume_async_stream(
        self,
        response: AsyncIterator[ModelStreamEvent],
        on_content_async: Callable[[str], Any],
        cancellation_token: CancellationToken | None = None,
        on_tool_input_started_async: Callable[[str, str], Any] | None = None,
        on_tool_input_delta_async: Callable[[str, str, str], Any] | None = None,
        on_tool_input_ended_async: Callable[[str, str], Any] | None = None,
    ) -> tuple[str, list[ParsedToolCall], ModelUsage | None, str | None, str | None]:
        """Consume a streaming response asynchronously, reassembling model output."""
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_calls: dict[str, dict] = {}
        usage: ModelUsage | None = None
        finish_reason: str | None = None

        async for event in response:
            if cancellation_token and cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)
            if event.kind == "text_delta":
                if event.text:
                    await on_content_async(event.text)
                    text_parts.append(event.text)
            elif event.kind == "reasoning_delta":
                if event.reasoning:
                    reasoning_parts.append(event.reasoning)
            elif event.kind == "tool_start":
                call = _slot(tool_calls, event.tool_call_id)
                call["name"] = event.tool_name or call["name"]
                if not call["started"]:
                    call["started"] = True
                    if on_tool_input_started_async:
                        await on_tool_input_started_async(event.tool_call_id, call["name"])
            elif event.kind == "tool_arguments_delta":
                call = _slot(tool_calls, event.tool_call_id, started=True)
                call["name"] = event.tool_name or call["name"]
                call["arguments"] += event.arguments
                if on_tool_input_delta_async and event.arguments:
                    await on_tool_input_delta_async(event.tool_call_id, call["name"], event.arguments)
            elif event.kind == "tool_end":
                call = tool_calls.get(event.tool_call_id)
                if call is not None and not call["ended"]:
                    call["ended"] = True
                    if on_tool_input_ended_async:
                        await on_tool_input_ended_async(event.tool_call_id, call["name"])
            elif event.kind == "usage":
                if event.usage is not None:
                    usage = event.usage
            elif event.kind == "completed":
                finish_reason = event.stop_reason

        if on_tool_input_ended_async:
            for call_id, call in tool_calls.items():
                if call["started"] and not call["ended"]:
                    await on_tool_input_ended_async(call_id, call["name"])

        calls = [
            ParsedToolCall(call_id=call_id, name=call["name"], raw_args=call["arguments"])
            for call_id, call in tool_calls.items()
            if call_id and call["name"]
        ]
        reasoning_content = "".join(reasoning_parts) if reasoning_parts else None
        return "".join(text_parts), calls, usage, reasoning_content, finish_reason


def _slot(tool_calls: dict[str, dict], call_id: str, *, started: bool = False) -> dict:
    call = tool_calls.get(call_id)
    if call is None:
        call = {"name": "", "arguments": "", "started": started, "ended": False}
        tool_calls[call_id] = call
    return call
