"""Google Generative AI (Gemini) adapter with lazy SDK loading."""

from __future__ import annotations

import asyncio
import itertools
import json
import re
from collections.abc import AsyncIterator
from typing import Any, Callable

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError
from agent.domain.models import ModelCompletion, ModelStreamEvent, ModelUsage
from agent.domain.tool_payload import ParsedToolCall

from .cancellation import await_with_cancellation


class GoogleGenerativeAIClient(ChatClient):
    def __init__(self, api_key: str, model: str, base_url: str | None = None, client: Any | None = None) -> None:
        if client is None:
            try:
                from google import genai
            except ImportError as exc:
                raise ProviderError("Google GenAI SDK is not installed.", status="unavailable", code="missing_sdk") from exc
            options = {"base_url": base_url} if base_url else None
            client = genai.Client(api_key=api_key, http_options=options)
        self._client = client
        self._model = model
        self._send_tool_call_ids = _requires_tool_call_ids(model)

    async def create(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> ModelCompletion:
        contents, config = _request(messages, tools, self._send_tool_call_ids)
        response = await await_with_cancellation(
            self._client.aio.models.generate_content(model=self._model, contents=contents, config=config),
            cancellation_token,
        )
        return _completion(response)

    async def stream(self, messages, tools=None, cancellation_token: CancellationToken | None = None) -> AsyncIterator[ModelStreamEvent]:
        contents, config = _request(messages, tools, self._send_tool_call_ids)
        fallback_id = _fallback_id_counter()
        try:
            stream = await await_with_cancellation(
                self._client.aio.models.generate_content_stream(model=self._model, contents=contents, config=config),
                cancellation_token,
            )
            async for raw in stream:
                if cancellation_token and cancellation_token.is_cancelled:
                    raise asyncio.CancelledError(cancellation_token.reason)
                for event in _events(raw, fallback_id):
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


def _request(messages, tools, send_tool_call_ids: bool) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    system, contents = _contents(messages, send_tool_call_ids)
    config: dict[str, Any] = {}
    if system:
        config["system_instruction"] = system
    if tools:
        config["tools"] = [{"function_declarations": [_declaration(tool) for tool in tools]}]
    return contents, config


def _contents(messages, send_tool_call_ids: bool) -> tuple[str, list[dict[str, Any]]]:
    system: list[str] = []
    contents: list[dict[str, Any]] = []
    names: dict[str, str] = {}
    for message in messages:
        role = message.get("role")
        if role == "system":
            system.append(str(message.get("content") or ""))
            continue
        if role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            response: dict[str, Any] = {"name": names.get(call_id, ""), "response": {"output": str(message.get("content") or "")}}
            if send_tool_call_ids:
                response["id"] = call_id
            part = {"function_response": response}
            last = contents[-1] if contents else None
            if last is not None and last["role"] == "user" and any("function_response" in item for item in last["parts"]):
                last["parts"].append(part)
            else:
                contents.append({"role": "user", "parts": [part]})
            continue
        parts: list[dict[str, Any]] = []
        if message.get("content"):
            parts.append({"text": str(message["content"])})
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            call_id = str(call.get("id") or "")
            function_call: dict[str, Any] = {"name": str(function.get("name") or ""), "args": _arguments(function.get("arguments"))}
            names[call_id] = function_call["name"]
            if send_tool_call_ids:
                function_call["id"] = call_id
            parts.append({"function_call": function_call})
        if parts:
            contents.append({"role": "model" if role == "assistant" else "user", "parts": parts})
    return "\n\n".join(system), contents


def _declaration(tool):
    function = tool.get("function") or tool
    return {"name": function.get("name", ""), "description": function.get("description", ""), "parameters": function.get("parameters", {})}


def _arguments(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _events(chunk: Any, fallback_id: Callable[[], str]) -> list[ModelStreamEvent]:
    events: list[ModelStreamEvent] = []
    usage = _usage(_get(chunk, "usage_metadata"))
    if usage is not None:
        events.append(ModelStreamEvent("usage", usage=usage))
    candidates = _get(chunk, "candidates") or []
    if not candidates:
        return events
    candidate = candidates[0]
    for part in _get(_get(candidate, "content"), "parts") or []:
        function_call = _get(part, "function_call")
        if function_call is not None:
            call_id = str(_get(function_call, "id") or "") or fallback_id()
            name = str(_get(function_call, "name") or "")
            events.append(ModelStreamEvent("tool_start", tool_call_id=call_id, tool_name=name))
            events.append(ModelStreamEvent("tool_arguments_delta", tool_call_id=call_id, tool_name=name, arguments=json.dumps(_get(function_call, "args") or {})))
            events.append(ModelStreamEvent("tool_end", tool_call_id=call_id))
            continue
        text = _get(part, "text")
        if not text:
            continue
        if _get(part, "thought"):
            events.append(ModelStreamEvent("reasoning_delta", reasoning=str(text)))
        else:
            events.append(ModelStreamEvent("text_delta", text=str(text)))
    finish = _get(candidate, "finish_reason")
    if finish is not None:
        events.append(ModelStreamEvent("completed", stop_reason=_stop_reason(str(finish))))
    return events


def _completion(response: Any) -> ModelCompletion:
    candidates = _get(response, "candidates") or []
    candidate = candidates[0] if candidates else None
    parts = _get(_get(candidate, "content"), "parts") or []
    content: list[str] = []
    reasoning: list[str] = []
    calls: list[ParsedToolCall] = []
    for index, part in enumerate(parts):
        text = _get(part, "text")
        function_call = _get(part, "function_call")
        if function_call is not None:
            call_id = str(_get(function_call, "id") or "") or f"call_{index}"
            calls.append(ParsedToolCall(call_id, str(_get(function_call, "name") or ""), json.dumps(_get(function_call, "args") or {})))
        elif text and _get(part, "thought"):
            reasoning.append(str(text))
        elif text:
            content.append(str(text))
    finish = _get(candidate, "finish_reason")
    return ModelCompletion(
        content="".join(content),
        tool_calls=tuple(calls),
        reasoning_content="".join(reasoning) or None,
        usage=_usage(_get(response, "usage_metadata")),
        finish_reason=_stop_reason(str(finish)) if finish is not None else None,
    )


def _usage(value: Any) -> ModelUsage | None:
    if value is None:
        return None
    return ModelUsage(
        input_tokens=int(_get(value, "prompt_token_count") or 0),
        output_tokens=int(_get(value, "candidates_token_count") or 0),
        cached_tokens=int(_get(value, "cached_content_token_count") or 0),
        reasoning_tokens=int(_get(value, "thoughts_token_count") or 0),
    )


def _stop_reason(value: str) -> str:
    reason = value.rsplit(".", 1)[-1].upper()
    return {
        "STOP": "stop",
        "MAX_TOKENS": "length",
        "SAFETY": "content_filter",
        "RECITATION": "content_filter",
        "PROHIBITED_CONTENT": "content_filter",
    }.get(reason, "error")


def _requires_tool_call_ids(model: str) -> bool:
    lowered = model.lower()
    major = re.match(r"gemini-(\d+)", lowered)
    return bool(major and int(major.group(1)) >= 3) or lowered.startswith("gpt-oss-")


def _fallback_id_counter() -> Callable[[], str]:
    counter = itertools.count()
    return lambda: f"call_{next(counter)}"


def _get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)
