"""Anthropic Messages API adapter with lazy SDK loading."""

from __future__ import annotations

import asyncio
from contextlib import aclosing
import base64
import json
from collections.abc import AsyncIterator
from typing import Any

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError
from agent.domain.models import ModelCompletion, ModelStreamEvent, ModelUsage
from agent.domain.tool_payload import ParsedToolCall

from .errors import provider_error
from .cancellation import await_with_cancellation, close_resource, iterate_with_cancellation


class AnthropicMessagesClient(ChatClient):
    def __init__(self, api_key: str, model: str, base_url: str | None = None, async_client: Any | None = None) -> None:
        if async_client is None:
            try:
                import anthropic
            except ImportError as exc:
                raise ProviderError("Anthropic SDK is not installed.", status="unavailable", code="missing_sdk") from exc
            kwargs = {"api_key": api_key}
            if base_url:
                kwargs["base_url"] = base_url
            async_client = anthropic.AsyncAnthropic(**kwargs)
        self._client = async_client
        self._model = model

    async def create(self, messages, tools=None, cancellation_token: CancellationToken | None = None, *, max_output_tokens: int | None = None, reasoning_effort: str | None = None) -> ModelCompletion:
        system, converted = _messages(messages)
        payload = {"model": self._model, "messages": converted, "max_tokens": max_output_tokens if max_output_tokens is not None else 32768}
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = [_anthropic_tool(tool) for tool in tools]
        try:
            response = await await_with_cancellation(self._client.messages.create(**payload), cancellation_token)
        except Exception as exc:
            raise provider_error(exc) from None
        return _completion(response)

    async def stream(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> AsyncIterator[ModelStreamEvent]:
        system, converted = _messages(messages)
        payload = {"model": self._model, "messages": converted, "max_tokens": 32768, "stream": True}
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = [_anthropic_tool(tool) for tool in tools]
        response = None
        usage: ModelUsage | None = None
        try:
            response = await await_with_cancellation(self._client.messages.create(**payload), cancellation_token)
            async with aclosing(iterate_with_cancellation(response, cancellation_token)) as chunks:
                async for raw in chunks:
                    events, usage = _events(raw, usage)
                    for event in events:
                        yield event
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise provider_error(exc, code="stream_interrupted") from None

        finally:
            await close_resource(response)

    async def close(self) -> None:
        await close_resource(self._client)


def _messages(messages):
    system: list[str] = []
    result: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        image_blocks = [{"type": "image", "source": {
            "type": "base64", "media_type": image["mime_type"],
            "data": base64.b64encode(image["data"]).decode("ascii"),
        }} for image in message.get("images", [])]
        if role == "system":
            system.append(str(message.get("content") or ""))
            continue
        if role == "tool":
            text = str(message.get("content") or "")
            content = ([{"type": "text", "text": text}] if text else []) + image_blocks if image_blocks else text
            block = {"type": "tool_result", "tool_use_id": str(message.get("tool_call_id") or ""), "content": content}
            try:
                payload = json.loads(text)
            except (ValueError, TypeError):
                payload = None
            if message.get("is_error") or isinstance(payload, dict) and payload.get("ok") is False:
                block["is_error"] = True
            if result and result[-1]["role"] == "user" and isinstance(result[-1]["content"], list) and any(item["type"] == "tool_result" for item in result[-1]["content"]):
                result[-1]["content"].append(block)
            else:
                result.append({"role": "user", "content": [block]})
            continue
        content: list[dict[str, Any]] = []
        if message.get("content"):
            content.append({"type": "text", "text": str(message["content"])})
        content.extend(image_blocks)
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            try:
                arguments = json.loads(function.get("arguments") or "{}")
            except (TypeError, ValueError):
                arguments = {}
            content.append({"type": "tool_use", "id": str(call.get("id") or ""), "name": str(function.get("name") or ""), "input": arguments})
        plain_text = len(content) == 1 and content[0]["type"] == "text"
        result.append({
            "role": "assistant" if role == "assistant" else "user",
            "content": content[0]["text"] if plain_text else (content or ""),
        })
    return "\n\n".join(system), result


def _anthropic_tool(tool):
    function = tool.get("function") or tool
    return {"name": function.get("name", ""), "description": function.get("description", ""), "input_schema": function.get("parameters", {})}


def _events(raw, previous_usage: ModelUsage | None = None) -> tuple[list[ModelStreamEvent], ModelUsage | None]:
    event_type = str(_get(raw, "type") or "")
    if event_type == "content_block_start":
        block = _get(raw, "content_block")
        if _get(block, "type") == "tool_use":
            return [ModelStreamEvent("tool_start", tool_call_id=str(_get(block, "id") or ""), tool_name=str(_get(block, "name") or ""))], previous_usage
    elif event_type == "content_block_delta":
        delta = _get(raw, "delta")
        kind = _get(delta, "type")
        if kind == "text_delta":
            return [ModelStreamEvent("text_delta", text=str(_get(delta, "text") or ""))], previous_usage
        if kind == "thinking_delta":
            return [ModelStreamEvent("reasoning_delta", reasoning=str(_get(delta, "thinking") or ""))], previous_usage
        if kind == "input_json_delta":
            return [ModelStreamEvent("tool_arguments_delta", arguments=str(_get(delta, "partial_json") or ""))], previous_usage
    elif event_type == "content_block_stop":
        return [ModelStreamEvent("tool_end")], previous_usage
    elif event_type == "message_delta":
        delta = _get(raw, "delta")
        usage = _usage(_get(raw, "usage"), previous_usage)
        events: list[ModelStreamEvent] = []
        if usage is not None:
            events.append(ModelStreamEvent("usage", usage=usage))
        events.append(ModelStreamEvent("completed", stop_reason={"end_turn": "stop", "tool_use": "tool_calls", "max_tokens": "length"}.get(str(_get(delta, "stop_reason") or ""), "error")))
        return events, usage or previous_usage
    elif event_type == "message_start":
        usage = _usage(_get(_get(raw, "message"), "usage"), previous_usage)
        return ([ModelStreamEvent("usage", usage=usage)] if usage else []), usage or previous_usage
    elif event_type == "error":
        error = _get(raw, "error") or raw
        raise provider_error(RuntimeError(str(_get(error, "message") or error)), code="stream_interrupted")
    return [], previous_usage


def _completion(response):
    content: list[str] = []
    reasoning: list[str] = []
    calls: list[ParsedToolCall] = []
    for block in _get(response, "content") or []:
        kind = _get(block, "type")
        if kind == "text":
            content.append(str(_get(block, "text") or ""))
        elif kind == "thinking":
            reasoning.append(str(_get(block, "thinking") or ""))
        elif kind == "tool_use":
            calls.append(ParsedToolCall(str(_get(block, "id") or ""), str(_get(block, "name") or ""), json.dumps(_get(block, "input") or {})))
    reason = {"end_turn": "stop", "tool_use": "tool_calls", "max_tokens": "length"}.get(str(_get(response, "stop_reason") or ""), "error")
    return ModelCompletion("".join(content), tuple(calls), "".join(reasoning) or None, _usage(_get(response, "usage")), reason)


def _usage(value, previous: ModelUsage | None = None) -> ModelUsage | None:
    if value is None:
        return None
    raw_input = _get(value, "input_tokens")
    raw_cache_read = _get(value, "cache_read_input_tokens")
    raw_cache_write = _get(value, "cache_creation_input_tokens")
    cache_read = int(raw_cache_read) if raw_cache_read is not None else (previous.cached_tokens if previous else 0)
    if raw_input is not None or raw_cache_read is not None or raw_cache_write is not None:
        uncached = int(raw_input or 0) if raw_input is not None else max(0, (previous.input_tokens - previous.cached_tokens) if previous else 0)
        input_tokens = uncached + cache_read + int(raw_cache_write or 0)
    else:
        input_tokens = previous.input_tokens if previous else 0
    raw_output = _get(value, "output_tokens")
    output_tokens = int(raw_output) if raw_output is not None else (previous.output_tokens if previous else 0)
    details = _get(value, "output_tokens_details")
    raw_reasoning = _get(details, "thinking_tokens") if details is not None else _get(value, "thinking_tokens")
    reasoning_tokens = int(raw_reasoning) if raw_reasoning is not None else (previous.reasoning_tokens if previous else 0)
    return ModelUsage(input_tokens, output_tokens, cache_read, reasoning_tokens)


def _get(value, key):
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)
