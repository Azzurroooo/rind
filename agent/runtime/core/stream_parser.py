"""Parses LLM responses, including streaming chunks and tool calls."""

from __future__ import annotations

import asyncio
from typing import Callable, AsyncIterator, Any

from agent.domain import ParsedToolCall
from agent.domain.cancellation import CancellationToken
from agent.domain.models import ModelStreamEvent


class MessageStreamParser:
    """Accumulates provider-neutral stream events into one model result."""

    async def consume_async_stream(
        self,
        response: AsyncIterator[Any],
        on_content_async: Callable[[str], Any],
        cancellation_token: CancellationToken | None = None,
        on_tool_input_started_async: Callable[[str, str], Any] | None = None,
        on_tool_input_delta_async: Callable[[str, str, str], Any] | None = None,
        on_tool_input_ended_async: Callable[[str, str], Any] | None = None,
    ) -> tuple[str, list[ParsedToolCall], Any | None, str | None, str | None]:
        """Consume a streaming response asynchronously, reassembling model output."""
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        reasoning_seen = False
        merged_tool_calls: list[dict] = []
        usage = None
        finish_reason = None

        async for chunk in response:
            if cancellation_token and cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)

            if isinstance(chunk, ModelStreamEvent) or isinstance(getattr(chunk, "kind", None), str):
                await self._consume_event(
                    chunk,
                    text_parts,
                    reasoning_parts,
                    merged_tool_calls,
                    on_content_async,
                    on_tool_input_started_async,
                    on_tool_input_delta_async,
                    on_tool_input_ended_async,
                )
                if getattr(chunk, "kind", "") == "usage" and getattr(chunk, "usage", None) is not None:
                    usage = chunk.usage
                if getattr(chunk, "kind", "") == "completed":
                    finish_reason = getattr(chunk, "stop_reason", None)
                if getattr(chunk, "kind", "") == "reasoning_delta":
                    reasoning_seen = True
                continue

            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage = chunk_usage

            if not getattr(chunk, "choices", None):
                continue

            choice = chunk.choices[0]
            choice_finish_reason = getattr(choice, "finish_reason", None)
            if choice_finish_reason is not None:
                finish_reason = str(choice_finish_reason)
            delta = choice.delta
            if delta.content:
                await on_content_async(delta.content)
                text_parts.append(delta.content)
            reasoning_delta = getattr(delta, "reasoning_content", None)
            if reasoning_delta is not None:
                reasoning_seen = True
                reasoning_parts.append(str(reasoning_delta))
            if delta.tool_calls:
                for item in delta.tool_calls:
                    index = item.index
                    while len(merged_tool_calls) <= index:
                        merged_tool_calls.append(
                            {"id": "", "name": "", "arguments": "", "started": False, "emitted": 0}
                        )
                    call = merged_tool_calls[index]
                    if item.id:
                        call["id"] = item.id
                    if item.function:
                        if item.function.name:
                            call["name"] = item.function.name
                        if item.function.arguments:
                            call["arguments"] += item.function.arguments
                    if call["id"] and call["name"] and not call["started"]:
                        call["started"] = True
                        if on_tool_input_started_async:
                            await on_tool_input_started_async(call["id"], call["name"])
                    if call["started"]:
                        pending = call["arguments"][call["emitted"] :]
                        if pending and on_tool_input_delta_async:
                            await on_tool_input_delta_async(call["id"], call["name"], pending)
                        call["emitted"] = len(call["arguments"])

        if on_tool_input_ended_async:
            for item in merged_tool_calls:
                if item["started"]:
                    await on_tool_input_ended_async(item["id"], item["name"])

        calls = [
            ParsedToolCall(call_id=item["id"], name=item["name"], raw_args=item["arguments"])
            for item in merged_tool_calls
            if item["id"] and item["name"]
        ]
        reasoning_content = "".join(reasoning_parts) if reasoning_seen else None
        return "".join(text_parts), calls, usage, reasoning_content, finish_reason

    async def _consume_event(
        self,
        event: ModelStreamEvent,
        text_parts: list[str],
        reasoning_parts: list[str],
        merged_tool_calls: list[dict],
        on_content_async: Callable[[str], Any],
        on_tool_input_started_async: Callable[[str, str], Any] | None,
        on_tool_input_delta_async: Callable[[str, str, str], Any] | None,
        on_tool_input_ended_async: Callable[[str, str], Any] | None,
    ) -> None:
        if event.kind == "text_delta":
            if event.text:
                await on_content_async(event.text)
                text_parts.append(event.text)
            return
        if event.kind == "reasoning_delta":
            reasoning_parts.append(event.reasoning)
            return
        if event.kind == "usage":
            return
        if event.kind == "tool_start":
            call = self._tool_call_slot(merged_tool_calls, event.tool_call_id)
            call["name"] = event.tool_name
            call["started"] = True
            if on_tool_input_started_async:
                await on_tool_input_started_async(event.tool_call_id, event.tool_name)
            return
        if event.kind == "tool_arguments_delta":
            call = self._tool_call_slot(merged_tool_calls, event.tool_call_id)
            call["name"] = event.tool_name or call["name"]
            call["arguments"] += event.arguments
            if on_tool_input_delta_async and event.arguments:
                await on_tool_input_delta_async(event.tool_call_id, call["name"], event.arguments)
            return
        if event.kind == "tool_end" and on_tool_input_ended_async:
            call = self._tool_call_slot(merged_tool_calls, event.tool_call_id)
            await on_tool_input_ended_async(event.tool_call_id, event.tool_name or call["name"])

    @staticmethod
    def _tool_call_slot(calls: list[dict], call_id: str) -> dict:
        for call in calls:
            if call["id"] == call_id:
                return call
        call = {"id": call_id, "name": "", "arguments": "", "started": True, "emitted": 0}
        calls.append(call)
        return call
