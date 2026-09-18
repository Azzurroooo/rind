"""Asynchronous OpenAI chat-completions adapter."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from typing import Any, AsyncIterator, Callable
import openai


from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError
from agent.infrastructure.llm.llm_trace import make_trace
from .cancellation import await_with_cancellation, close_resource


logger = logging.getLogger(__name__)


def build_async_client(api_key: str, base_url: str, *, max_retries: int = 2) -> openai.AsyncOpenAI:
    from agent.infrastructure.config.settings_loader import DEFAULT_USER_AGENT

    return openai.AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        max_retries=max_retries,
        default_headers={"User-Agent": DEFAULT_USER_AGENT},
    )


class OpenAIChatClient(ChatClient):
    """Small wrapper around OpenAI async chat.completions API with resilient retries and cancellation support."""

    def __init__(
        self,
        async_client: Any,
        model: str,
        reasoning_effort: str | None = None,
        workspace_root: str | None = None,
    ):
        self._client = async_client
        self._model = model
        self._reasoning_effort = (reasoning_effort or "").strip() or None
        self._reasoning_effort_disabled = False
        self._prompt_cache_key_disabled = False
        self._trace_session_id_provider: Callable[[], str] | None = None
        self._workspace_root = workspace_root

    def set_trace_session_id_provider(self, provider: Callable[[], str] | None) -> None:
        """TEMPORARY: install a provider returning the active session id for LLM tracing."""
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
    ) -> Any:
        trace = make_trace(self._trace_session_id_provider, label="create")
        if trace:
            trace.request(self._trace_payload(messages, tools, stream=False))

        try:
            result = await self._request(messages, tools, False, cancellation_token)
            if trace:
                trace.response(result)
                trace.end("completed")
            return result
        except asyncio.CancelledError:
            if trace:
                trace.end("cancelled")
            raise
        except Exception as exc:
            if trace:
                trace.end("error", str(exc))
            raise self._provider_error(exc) from exc

    async def stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> AsyncIterator[Any]:
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
            raise self._provider_error(exc) from exc

        # Now consume the stream chunks with cancellation checks. Each chunk is
        # recorded BEFORE it is yielded upstream so the trace reflects the raw
        # provider output that the runtime then acted on.
        ended = False
        try:
            async for chunk in stream_response:
                if cancellation_token and cancellation_token.is_cancelled:
                    ended = True
                    if trace:
                        trace.end("cancelled")
                    raise asyncio.CancelledError(cancellation_token.reason)
                if trace:
                    trace.response_chunk(chunk)
                yield chunk
        except asyncio.CancelledError:
            if not ended and trace:
                trace.end("cancelled")
                ended = True
            raise
        except Exception as exc:
            if trace:
                trace.end("stream_error", str(exc))
            ended = True
            raise self._provider_error(exc, code="stream_interrupted") from exc
        finally:
            if trace and not ended:
                trace.end("completed")
            try:
                await close_resource(stream_response)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise self._provider_error(exc, code="stream_interrupted") from exc

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

    def _provider_error(self, exc: Exception, code: str | None = None) -> ProviderError:
        if isinstance(exc, ProviderError):
            return exc
        error_type = type(exc).__name__
        text = str(exc)
        lowered = text.lower()
        if "context_length_exceeded" in lowered or "maximum context length" in lowered:
            return ProviderError(
                text,
                status="rejected",
                error_type=error_type,
                code="context_length_exceeded",
            )
        if isinstance(exc, (asyncio.TimeoutError, TimeoutError, openai.APITimeoutError)):
            status = "timed_out"
        elif isinstance(exc, openai.APIStatusError):
            status_code = getattr(exc, "status_code", None)
            if status_code in {400, 401, 403, 404, 409, 422}:
                status = "rejected"
            elif status_code in {408, 504}:
                status = "timed_out"
            elif status_code == 429 or isinstance(status_code, int) and status_code >= 500:
                status = "unavailable"
            else:
                status = "failed"
        elif isinstance(exc, (openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)):
            status = "unavailable"
        else:
            status = "failed"
        return ProviderError(text, status=status, error_type=error_type, code=code)


    async def _request(self, messages, tools, stream, cancellation_token):
        if cancellation_token and cancellation_token.is_cancelled:
            raise asyncio.CancelledError(cancellation_token.reason)
        payload = {"model": self._model, "messages": messages, "stream": stream}
        if stream:
            payload["stream_options"] = {"include_usage": True}
        if tools:
            payload.update(tools=tools, tool_choice="auto")
        self._add_prompt_cache_key(payload)
        return await await_with_cancellation(
            self._create_with_optional_reasoning_effort(payload), cancellation_token
        )

    async def _create_with_optional_reasoning_effort(self, kwargs: dict[str, Any]) -> Any:
        payload = dict(kwargs)
        if self._reasoning_effort and not self._reasoning_effort_disabled:
            payload["reasoning_effort"] = self._reasoning_effort
        try:
            return await self._client.chat.completions.create(**payload)
        except openai.APIStatusError as exc:
            fallback_payload = dict(payload)
            should_retry = False
            if "reasoning_effort" in fallback_payload and self._should_retry_without_reasoning_effort(exc):
                fallback_payload.pop("reasoning_effort", None)
                self._reasoning_effort_disabled = True
                should_retry = True
            if "prompt_cache_key" in fallback_payload and self._should_retry_without_prompt_cache_key(exc):
                fallback_payload.pop("prompt_cache_key", None)
                self._prompt_cache_key_disabled = True
                should_retry = True
            if not should_retry:
                raise
            return await self._client.chat.completions.create(**fallback_payload)

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
