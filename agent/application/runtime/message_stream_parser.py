"""Parses LLM responses, including streaming chunks and tool calls."""

from __future__ import annotations

import asyncio
from typing import Callable, AsyncIterator, Any

from agent.domain import ParsedToolCall
from agent.application.runtime.cancellation import CancellationToken


class MessageStreamParser:
    """Parses OpenAI-compatible message streams and structures."""

    async def consume_async_stream(
        self,
        response: AsyncIterator[Any],
        on_content_async: Callable[[str], Any],
        cancellation_token: CancellationToken | None = None
    ) -> tuple[str, list[ParsedToolCall], Any | None]:
        """Consume a streaming response asynchronously, reassembling text and tool calls."""
        text_parts: list[str] = []
        merged_tool_calls: list[dict] = []
        usage = None

        async for chunk in response:
            if cancellation_token and cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)

            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage = chunk_usage

            if not getattr(chunk, "choices", None):
                continue

            delta = chunk.choices[0].delta
            if delta.content:
                await on_content_async(delta.content)
                text_parts.append(delta.content)
            if delta.tool_calls:
                for item in delta.tool_calls:
                    index = item.index
                    while len(merged_tool_calls) <= index:
                        merged_tool_calls.append({"id": "", "name": "", "arguments": ""})
                    if item.id:
                        merged_tool_calls[index]["id"] = item.id
                    if item.function:
                        if item.function.name:
                            merged_tool_calls[index]["name"] = item.function.name
                        if item.function.arguments:
                            merged_tool_calls[index]["arguments"] += item.function.arguments

        calls = [
            ParsedToolCall(call_id=item["id"], name=item["name"], raw_args=item["arguments"])
            for item in merged_tool_calls
            if item["id"] and item["name"]
        ]
        return "".join(text_parts), calls, usage
