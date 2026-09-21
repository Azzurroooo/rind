"""OpenAI Chat Completions with neutral results, retries and cancellation."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from typing import Any, AsyncIterator, Callable

import openai
from agent.infrastructure.llm.images import chat_messages

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from .errors import provider_error
from agent.domain.models import ModelCompletion, ModelStreamEvent, ModelUsage
from agent.domain.tool_payload import ParsedToolCall
from agent.infrastructure.llm.cancellation import await_with_cancellation, close_resource, iterate_with_cancellation
from agent.infrastructure.llm.catalog import resolve_reasoning_effort
from agent.infrastructure.llm.trace import make_trace


class OpenAIChatCompletionsClient(ChatClient):
    """Small wrapper around OpenAI async chat.completions API with resilient retries and cancellation support."""

    def __init__(
        self,
        async_client: Any,
        model: str,
        reasoning_effort: str | None = None,
        workspace_root: str | None = None,
        *,
        reasoning_efforts: tuple[str, ...] = (),
    ):
        self._client = async_client
        self._model = model
        self._reasoning_effort = (reasoning_effort or "").strip() or None
        self._reasoning_efforts = reasoning_efforts
        self._reasoning_effort_disabled = False
        self._prompt_cache_key_disabled = False
        self._trace_session_id_provider: Callable[[], str] | None = None
        self._workspace_root = workspace_root

    def set_trace_session_id_provider(self, provider: Callable[[], str] | None) -> None:
        """Bind request traces to the active session."""
        self._trace_session_id_provider = provider

    @property
    def model(self) -> str:
        return self._model

    async def close(self) -> None:
        await close_resource(self._client)

    async def create(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
        *,
        max_output_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> ModelCompletion:
        trace = make_trace(self._trace_session_id_provider, label="create")
        if trace:
            payload = self._trace_payload(messages, tools, stream=False)
            payload["reasoning_effort"] = resolve_reasoning_effort(self._reasoning_effort, reasoning_effort, self._reasoning_efforts)
            if max_output_tokens is not None:
                payload["max_tokens"] = max_output_tokens
            trace.request(payload)

        try:
            result = await self._request(
                messages, tools, False, cancellation_token,
                max_output_tokens=max_output_tokens, reasoning_effort=reasoning_effort,
            )
            if trace:
                trace.response(result)
                trace.end("completed")
            return _completion(result)
        except asyncio.CancelledError:
            if trace:
                trace.end("cancelled")
            raise
        except Exception as exc:
            if trace:
                trace.end("error", str(exc))
            raise provider_error(exc) from None

    async def stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> AsyncIterator[ModelStreamEvent]:
        trace = make_trace(self._trace_session_id_provider, label="stream")
        if trace:
            trace.request(self._trace_payload(messages, tools, stream=True))

        # We need to retry the initial connection, but not the entire stream
        # once it starts yielding chunks.

        try:
            stream_response = await self._request(messages, tools, True, cancellation_token)
        except asyncio.CancelledError:
            if trace:
                trace.end("cancelled")
            raise
        except Exception as exc:
            if trace:
                trace.end("connect_error", str(exc))
            raise provider_error(exc) from None

        # Now consume the stream chunks with cancellation checks. Each chunk is
        # recorded BEFORE it is yielded upstream so the trace reflects the raw
        # provider output that the runtime then acted on.
        ended = False
        call_ids: dict[int, str] = {}
        try:
            async for chunk in iterate_with_cancellation(stream_response, cancellation_token):
                if cancellation_token and cancellation_token.is_cancelled:
                    ended = True
                    if trace:
                        trace.end("cancelled")
                    raise asyncio.CancelledError(cancellation_token.reason)
                if trace:
                    trace.response_chunk(chunk)
                for event in _events(chunk, call_ids):
                    yield event
        except asyncio.CancelledError:
            if not ended and trace:
                trace.end("cancelled")
                ended = True
            raise
        except Exception as exc:
            if trace:
                trace.end("stream_error", str(exc))
            ended = True
            raise provider_error(exc, code="stream_interrupted") from None
        finally:
            if trace and not ended:
                trace.end("completed")
            try:
                await close_resource(stream_response)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise provider_error(exc, code="stream_interrupted") from None

    def _trace_payload(self, messages: list[dict], tools: list[dict] | None, *, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "tools": tools or [],
            "tool_choice": "auto" if tools else None,
            "stream": stream,
            "reasoning_effort": self._reasoning_effort,
            "reasoning_effort_disabled": self._reasoning_effort_disabled,
            "prompt_cache_key_disabled": self._prompt_cache_key_disabled,
        }
        if stream:
            payload["stream_options"] = {"include_usage": True}
        return payload

    async def _request(self, messages, tools, stream, cancellation_token, *, max_output_tokens=None, reasoning_effort=None):
        if cancellation_token and cancellation_token.is_cancelled:
            raise asyncio.CancelledError(cancellation_token.reason)
        payload = {"model": self._model, "messages": chat_messages(messages), "stream": stream}
        if max_output_tokens is not None:
            payload["max_tokens"] = max_output_tokens
        if stream:
            payload["stream_options"] = {"include_usage": True}
        if tools:
            payload.update(tools=tools, tool_choice="auto")
        self._add_prompt_cache_key(payload)
        return await await_with_cancellation(
            self._create_with_optional_reasoning_effort(payload, reasoning_effort=reasoning_effort), cancellation_token
        )

    async def _create_with_optional_reasoning_effort(self, kwargs: dict[str, Any], *, reasoning_effort: str | None = None) -> Any:
        payload = dict(kwargs)
        effort = resolve_reasoning_effort(self._reasoning_effort, reasoning_effort, self._reasoning_efforts)
        if effort and not self._reasoning_effort_disabled:
            payload["reasoning_effort"] = effort
        while True:
            try:
                return await self._client.chat.completions.create(**payload)
            except openai.APIStatusError as exc:
                if "max_tokens" in payload and self._should_retry_with_max_completion_tokens(exc):
                    payload["max_completion_tokens"] = payload.pop("max_tokens")
                elif "prompt_cache_key" in payload and self._should_retry_without_prompt_cache_key(exc):
                    payload.pop("prompt_cache_key")
                    self._prompt_cache_key_disabled = True
                elif "reasoning_effort" in payload and self._should_retry_without_reasoning_effort(exc):
                    payload.pop("reasoning_effort")
                    if reasoning_effort is None:
                        self._reasoning_effort_disabled = True
                else:
                    raise

    def _should_retry_with_max_completion_tokens(self, exc: Exception) -> bool:
        text = str(exc).lower()
        return getattr(exc, "status_code", None) in {400, 422} and "max_tokens" in text and any(
            marker in text for marker in ("unsupported", "unknown", "unrecognized", "not support", "extra_forbidden")
        )

    def _add_prompt_cache_key(self, kwargs: dict[str, Any]) -> None:
        if self._prompt_cache_key_disabled:
            return
        kwargs["prompt_cache_key"] = self._build_prompt_cache_key(
            messages=kwargs.get("messages") or [],
            tools=kwargs.get("tools") or [],
        )

    def _build_prompt_cache_key(self, *, messages: list[dict], tools: list[dict]) -> str:
        system_parts = [
            str(message.get("content") or "")
            for message in messages
            if isinstance(message, dict) and message.get("role") == "system"
        ]
        payload = {
            "model": self._model,
            "cwd": os.path.normcase(os.path.realpath(self._workspace_root or os.getcwd())),
            "system": system_parts,
            "tools": tools,
        }
        digest = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()[:24]
        return f"rind:{digest}"

    def _should_retry_without_reasoning_effort(self, exc: Exception) -> bool:
        text = str(exc).lower()
        return any(
            marker in text
            for marker in (
                "reasoning_effort",
                "request was blocked",
                "blocked",
                "unsupported",
                "unknown",
                "invalid",
                "unrecognized",
                "not support",
                "not supported",
                "extra_forbidden",
            )
        )

    def _should_retry_without_prompt_cache_key(self, exc: Exception) -> bool:
        text = str(exc).lower()
        return "prompt_cache_key" in text and any(
            marker in text
            for marker in (
                "unsupported",
                "unknown",
                "invalid",
                "unrecognized",
                "not support",
                "not supported",
                "extra_forbidden",
            )
        )


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
