"""Provider-neutral adapter for OpenAI Chat Completions."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from agent.domain.models import ModelCompletion, ModelStreamEvent, ModelUsage
from agent.domain.tool_payload import ParsedToolCall

from .openai_chat_client import OpenAIChatClient


class OpenAIChatCompletionsClient(ChatClient):
    def __init__(self, async_client: Any, model: str, reasoning_effort: str = "", workspace_root: str | None = None, *, reasoning_efforts: tuple[str, ...] = ()) -> None:
        self._client = OpenAIChatClient(async_client, model, reasoning_effort, workspace_root, reasoning_efforts=reasoning_efforts)

    async def create(self, messages, tools=None, cancellation_token: CancellationToken | None = None, *, max_output_tokens: int | None = None, reasoning_effort: str | None = None) -> ModelCompletion:
        return _completion(await self._client.create(
            messages, tools, cancellation_token, max_output_tokens=max_output_tokens, reasoning_effort=reasoning_effort,
        ))

    async def stream(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> AsyncIterator[ModelStreamEvent]:
        call_ids: dict[int, str] = {}
        async for chunk in self._client.stream(messages, tools, cancellation_token):
            for event in _events(chunk, call_ids):
                yield event

    async def close(self) -> None:
        await self._client.close()

    def set_trace_session_id_provider(self, provider) -> None:
        self._client.set_trace_session_id_provider(provider)


def _events(chunk: Any, call_ids: dict[int, str] | None = None) -> list[ModelStreamEvent]:
    usage = _usage(_get(chunk, "usage"))
    events: list[ModelStreamEvent] = []
    choices = _get(chunk, "choices") or []
    if usage is not None:
        events.append(ModelStreamEvent("usage", usage=usage))
    if not choices:
        return events
    choice = choices[0]
    delta = _get(choice, "delta")
    if delta is not None:
        text = _get(delta, "content")
        if text:
            events.append(ModelStreamEvent("text_delta", text=str(text)))
        reasoning = _get(delta, "reasoning_content")
        if reasoning is not None:
            events.append(ModelStreamEvent("reasoning_delta", reasoning=str(reasoning)))
        for call in _get(delta, "tool_calls") or []:
            function = _get(call, "function")
            index = int(_get(call, "index") or 0)
            call_id = str(_get(call, "id") or "")
            if call_id and call_ids is not None:
                call_ids[index] = call_id
            elif call_ids is not None:
                call_id = call_ids.get(index, "")
            name = str(_get(function, "name") or "")
            if call_id and name:
                events.append(ModelStreamEvent("tool_start", tool_call_id=call_id, tool_name=name))
            arguments = _get(function, "arguments")
            if arguments:
                events.append(ModelStreamEvent("tool_arguments_delta", tool_call_id=call_id, tool_name=name, arguments=str(arguments)))
    finish = _get(choice, "finish_reason")
    if finish is not None:
        events.append(ModelStreamEvent("completed", stop_reason=_stop_reason(str(finish))))
    return events


def _completion(response: Any) -> ModelCompletion:
    choices = _get(response, "choices") or []
    message = _get(choices[0], "message") if choices else None
    calls = []
    for call in _get(message, "tool_calls") or []:
        function = _get(call, "function")
        calls.append(ParsedToolCall(str(_get(call, "id") or ""), str(_get(function, "name") or ""), str(_get(function, "arguments") or "")))
    return ModelCompletion(
        content=str(_get(message, "content") or ""),
        tool_calls=tuple(calls),
        reasoning_content=_get(message, "reasoning_content"),
        usage=_usage(_get(response, "usage")),
        finish_reason=_stop_reason(str(_get(choices[0], "finish_reason"))) if choices and _get(choices[0], "finish_reason") else None,
    )


def _usage(value: Any) -> ModelUsage | None:
    if value is None:
        return None
    details = _get(value, "prompt_tokens_details")
    completion_details = _get(value, "completion_tokens_details")
    return ModelUsage(
        input_tokens=int(_get(value, "prompt_tokens") or _get(value, "input_tokens") or 0),
        output_tokens=int(_get(value, "completion_tokens") or _get(value, "output_tokens") or 0),
        cached_tokens=int(_get(details, "cached_tokens") or 0),
        reasoning_tokens=int(_get(completion_details, "reasoning_tokens") or 0),
    )


def _stop_reason(value: str):
    return {"stop": "stop", "tool_calls": "tool_calls", "length": "length", "content_filter": "content_filter"}.get(value, "error")


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)
