"""OpenAI Responses API adapter."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError
from agent.domain.models import ModelCompletion, ModelStreamEvent, ModelUsage
from agent.domain.tool_payload import ParsedToolCall
from .cancellation import await_with_cancellation, close_resource
from .providers import resolve_reasoning_effort


class OpenAIResponsesClient(ChatClient):
    def __init__(self, async_client: Any, model: str, reasoning_effort: str = "", workspace_root: str | None = None, *, reasoning_efforts: tuple[str, ...] = ()) -> None:
        self._client = async_client
        self._model = model
        self._reasoning_effort = reasoning_effort or ""
        self._reasoning_efforts = reasoning_efforts

    async def create(self, messages, tools=None, cancellation_token: CancellationToken | None = None, *, max_output_tokens: int | None = None, reasoning_effort: str | None = None) -> ModelCompletion:
        payload = self._payload(messages, tools, stream=False)
        if max_output_tokens is not None:
            payload["max_output_tokens"] = max_output_tokens
        effort = resolve_reasoning_effort(self._reasoning_effort, reasoning_effort, self._reasoning_efforts)
        if effort:
            payload["reasoning"] = {"effort": effort}
        response = await await_with_cancellation(self._client.responses.create(**payload), cancellation_token)
        return _completion(response)

    async def stream(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> AsyncIterator[ModelStreamEvent]:
        payload = self._payload(messages, tools, stream=True)
        call_ids: dict[str, str] = {}
        response = None
        try:
            response = await await_with_cancellation(self._client.responses.create(**payload), cancellation_token)
            async for raw in response:
                if cancellation_token and cancellation_token.is_cancelled:
                    raise asyncio.CancelledError(cancellation_token.reason)
                for event in _events(raw, call_ids):
                    yield event
        except asyncio.CancelledError:
            raise
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(str(exc), status="unavailable", error_type=type(exc).__name__, code="stream_interrupted") from exc
        finally:
            await close_resource(response)

    async def close(self) -> None:
        await close_resource(self._client)

    def _payload(self, messages, tools, *, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": self._model, "input": _input_items(messages), "stream": stream}
        if tools:
            payload["tools"] = [_response_tool(tool) for tool in tools]
        if self._reasoning_effort:
            payload["reasoning"] = {"effort": self._reasoning_effort}
        return payload


def _input_items(messages: list[dict[str, Any]]) -> list[Any]:
    items: list[Any] = []
    for message in messages:
        role = message.get("role")
        if role == "tool":
            items.append({"type": "function_call_output", "call_id": str(message.get("tool_call_id") or ""), "output": str(message.get("content") or "")})
            continue
        calls = message.get("tool_calls") if role == "assistant" else None
        if calls:
            if message.get("content"):
                items.append({"role": "assistant", "content": message["content"]})
            for call in calls:
                function = call.get("function") or {}
                items.append({"type": "function_call", "call_id": str(call.get("id") or ""), "name": str(function.get("name") or ""), "arguments": str(function.get("arguments") or "{}")})
            continue
        items.append({"role": role, "content": message.get("content") or ""})
    return items


def _response_tool(tool: dict[str, Any]) -> dict[str, Any]:
    function = tool.get("function") or tool
    return {"type": "function", "name": function.get("name", ""), "description": function.get("description", ""), "parameters": function.get("parameters", {})}


def _events(raw: Any, call_ids: dict[str, str] | None = None) -> list[ModelStreamEvent]:
    kind = str(_get(raw, "type") or "")
    events: list[ModelStreamEvent] = []
    if kind == "response.output_text.delta":
        events.append(ModelStreamEvent("text_delta", text=str(_get(raw, "delta") or "")))
    elif kind in {"response.reasoning_summary_text.delta", "response.reasoning_text.delta"}:
        events.append(ModelStreamEvent("reasoning_delta", reasoning=str(_get(raw, "delta") or "")))
    elif kind == "response.output_item.added":
        item = _get(raw, "item")
        if _get(item, "type") == "function_call":
            call_id = str(_get(item, "call_id") or _get(item, "id") or "")
            item_id = str(_get(item, "id") or "")
            if call_ids is not None and item_id:
                call_ids[item_id] = call_id
            events.append(ModelStreamEvent("tool_start", tool_call_id=call_id, tool_name=str(_get(item, "name") or "")))
    elif kind == "response.function_call_arguments.delta":
        item_id = str(_get(raw, "item_id") or "")
        call_id = str(_get(raw, "call_id") or (call_ids or {}).get(item_id, "") or item_id)
        events.append(ModelStreamEvent("tool_arguments_delta", tool_call_id=call_id, tool_name=str(_get(raw, "name") or ""), arguments=str(_get(raw, "delta") or "")))
    elif kind == "response.function_call_arguments.done":
        item_id = str(_get(raw, "item_id") or "")
        call_id = str(_get(raw, "call_id") or (call_ids or {}).get(item_id, "") or item_id)
        events.append(ModelStreamEvent("tool_end", tool_call_id=call_id, tool_name=str(_get(raw, "name") or "")))
    elif kind in {"response.completed", "response.incomplete"}:
        response = _get(raw, "response") or raw
        usage = _usage(_get(response, "usage"))
        if usage:
            events.append(ModelStreamEvent("usage", usage=usage))
        status = str(_get(response, "status") or "completed")
        events.append(ModelStreamEvent("completed", stop_reason="stop" if kind.endswith("completed") and status == "completed" else "length" if status == "incomplete" else "error"))
    return [event for event in events if event.kind != "text_delta" or event.text]


def _completion(response: Any) -> ModelCompletion:
    content: list[str] = []
    reasoning: list[str] = []
    calls: list[ParsedToolCall] = []
    for item in _get(response, "output") or []:
        item_type = _get(item, "type")
        if item_type == "message":
            for part in _get(item, "content") or []:
                if _get(part, "type") in {"output_text", "text"}:
                    content.append(str(_get(part, "text") or ""))
        elif item_type == "function_call":
            calls.append(ParsedToolCall(str(_get(item, "call_id") or _get(item, "id") or ""), str(_get(item, "name") or ""), str(_get(item, "arguments") or "{}")))
    status = str(_get(response, "status") or "completed")
    finish_reason = "tool_calls" if calls else "stop"
    if status != "completed":
        finish_reason = "length" if status == "incomplete" else "error"
    return ModelCompletion("".join(content), tuple(calls), "".join(reasoning) or None, _usage(_get(response, "usage")), finish_reason)


def _usage(value: Any) -> ModelUsage | None:
    if value is None:
        return None
    return ModelUsage(int(_get(value, "input_tokens") or 0), int(_get(value, "output_tokens") or 0), int(_get(value, "input_tokens_details") and _get(_get(value, "input_tokens_details"), "cached_tokens") or 0), int(_get(value, "reasoning_tokens") or 0))


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)
