"""Anthropic Messages API adapter with lazy SDK loading."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError
from agent.domain.models import ModelCompletion, ModelStreamEvent, ModelUsage
from agent.domain.tool_payload import ParsedToolCall


class AnthropicMessagesClient(ChatClient):
    def __init__(self, api_key: str, model: str, reasoning_effort: str = "", base_url: str | None = None, async_client: Any | None = None) -> None:
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
        self._reasoning_effort = reasoning_effort

    async def create(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> ModelCompletion:
        system, converted = _messages(messages)
        payload = {"model": self._model, "messages": converted, "max_tokens": 32768}
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = [_anthropic_tool(tool) for tool in tools]
        response = await _await(self._client.messages.create(**payload), cancellation_token)
        return _completion(response)

    async def stream(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> AsyncIterator[ModelStreamEvent]:
        system, converted = _messages(messages)
        payload = {"model": self._model, "messages": converted, "max_tokens": 32768, "stream": True}
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = [_anthropic_tool(tool) for tool in tools]
        try:
            response = await _await(self._client.messages.create(**payload), cancellation_token)
            async for raw in response:
                if cancellation_token and cancellation_token.is_cancelled:
                    raise asyncio.CancelledError(cancellation_token.reason)
                event = _event(raw)
                if event:
                    yield event
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise ProviderError(str(exc), status="unavailable", error_type=type(exc).__name__, code="stream_interrupted") from exc

    async def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            result = close()
            if hasattr(result, "__await__"):
                await result


def _messages(messages):
    system: list[str] = []
    result: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            system.append(str(message.get("content") or ""))
            continue
        if role == "tool":
            result.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": str(message.get("tool_call_id") or ""), "content": str(message.get("content") or "")} ]})
            continue
        content: list[dict[str, Any]] = []
        if message.get("content"):
            content.append({"type": "text", "text": str(message["content"])})
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            try:
                import json
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


def _event(raw):
    event_type = str(_get(raw, "type") or "")
    if event_type == "content_block_start":
        block = _get(raw, "content_block")
        if _get(block, "type") == "tool_use":
            return ModelStreamEvent("tool_start", tool_call_id=str(_get(block, "id") or ""), tool_name=str(_get(block, "name") or ""))
    if event_type == "content_block_delta":
        delta = _get(raw, "delta")
        kind = _get(delta, "type")
        if kind == "text_delta":
            return ModelStreamEvent("text_delta", text=str(_get(delta, "text") or ""))
        if kind == "thinking_delta":
            return ModelStreamEvent("reasoning_delta", reasoning=str(_get(delta, "thinking") or ""))
        if kind == "input_json_delta":
            return ModelStreamEvent("tool_arguments_delta", arguments=str(_get(delta, "partial_json") or ""))
    if event_type == "content_block_stop":
        return ModelStreamEvent("tool_end")
    if event_type == "message_delta":
        delta = _get(raw, "delta")
        return ModelStreamEvent("completed", stop_reason={"end_turn": "stop", "tool_use": "tool_calls", "max_tokens": "length"}.get(str(_get(delta, "stop_reason") or ""), "error"))
    if event_type == "message_start":
        usage = _usage(_get(_get(raw, "message"), "usage"))
        return ModelStreamEvent("usage", usage=usage) if usage else None
    return None


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
            import json
            calls.append(ParsedToolCall(str(_get(block, "id") or ""), str(_get(block, "name") or ""), json.dumps(_get(block, "input") or {})))
    reason = {"end_turn": "stop", "tool_use": "tool_calls", "max_tokens": "length"}.get(str(_get(response, "stop_reason") or ""), "error")
    return ModelCompletion("".join(content), tuple(calls), "".join(reasoning) or None, _usage(_get(response, "usage")), reason)


def _usage(value):
    if value is None:
        return None
    return ModelUsage(int(_get(value, "input_tokens") or 0), int(_get(value, "output_tokens") or 0), int(_get(value, "cache_read_input_tokens") or 0), 0)


async def _await(awaitable, cancellation_token):
    task = asyncio.create_task(awaitable)
    if cancellation_token is None:
        return await task
    cancel = asyncio.create_task(cancellation_token.wait())
    done, _ = await asyncio.wait((task, cancel), return_when=asyncio.FIRST_COMPLETED)
    if cancel in done:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise asyncio.CancelledError(cancellation_token.reason)
    cancel.cancel()
    await asyncio.gather(cancel, return_exceptions=True)
    return task.result()


def _get(value, key):
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)
