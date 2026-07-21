"""Asynchronous OpenAI chat-completions adapter."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from typing import Any, AsyncIterator
import openai
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    RetryCallState,
)

from agent.application.ports.chat_client import ChatClient
from agent.domain.cancellation import CancellationToken


class OpenAIChatClient(ChatClient):
    """Small wrapper around OpenAI async chat.completions API with resilient retries and cancellation support."""

    def __init__(self, async_client: Any, model: str, reasoning_effort: str | None = None):
        self._client = async_client
        self._model = model
        self._reasoning_effort = (reasoning_effort or "").strip() or None
        self._reasoning_effort_disabled = False
        self._prompt_cache_key_disabled = False
        self.on_retry = None  # Callback function: def on_retry(attempt: int, exception: Exception)

    @property
    def model(self) -> str:
        return self._model

    def set_model(self, model: str) -> None:
        clean = str(model or "").strip()
        if not clean:
            raise ValueError("Model name is required.")
        self._model = clean
        self._reasoning_effort_disabled = False
        self._prompt_cache_key_disabled = False

    def _before_sleep_log(self, retry_state: RetryCallState):
        if self.on_retry and retry_state.outcome and retry_state.outcome.failed:
            self.on_retry(retry_state.attempt_number, retry_state.outcome.exception())

    @property
    def _retry_decorator(self):
        return retry(
            retry=retry_if_exception_type((
                openai.RateLimitError,
                openai.APITimeoutError,
                openai.InternalServerError,
                openai.APIConnectionError,
            )),
            wait=wait_exponential(multiplier=1, min=2, max=10),
            stop=stop_after_attempt(5),
            before_sleep=self._before_sleep_log,
            reraise=True,
        )

    async def create(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> Any:

        @self._retry_decorator
        async def _do_create():
            if cancellation_token and cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)

            kwargs = {
                "model": self._model,
                "messages": messages,
                "stream": False,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            self._add_prompt_cache_key(kwargs)

            # For non-streaming create, we await it.
            # To be fully responsive to cancellation mid-flight, we wrap it in a task.
            return await self._await_with_cancellation(
                self._create_with_optional_reasoning_effort(kwargs),
                cancellation_token,
            )

        return await _do_create()

    async def stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> AsyncIterator[Any]:

        # We need to retry the initial connection, but not the entire stream
        # once it starts yielding chunks.

        @self._retry_decorator
        async def _do_connect():
            if cancellation_token and cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)

            kwargs = {
                "model": self._model,
                "messages": messages,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            self._add_prompt_cache_key(kwargs)

            return await self._await_with_cancellation(
                self._create_with_optional_reasoning_effort(kwargs),
                cancellation_token,
            )

        stream_response = await _do_connect()

        # Now consume the stream chunks with cancellation checks
        try:
            async for chunk in stream_response:
                if cancellation_token and cancellation_token.is_cancelled:
                    raise asyncio.CancelledError(cancellation_token.reason)
                yield chunk
        finally:
            await self._close_stream(stream_response)

    async def _close_stream(self, stream_response: Any) -> None:
        close = getattr(stream_response, "aclose", None) or getattr(stream_response, "close", None)
        if not callable(close):
            return
        result = close()
        if asyncio.iscoroutine(result):
            await result

    async def _await_with_cancellation(self, awaitable: Any, cancellation_token: CancellationToken | None) -> Any:
        task = asyncio.create_task(awaitable)
        if not cancellation_token:
            return await task

        cancel_task = asyncio.create_task(cancellation_token.wait())
        try:
            done, _ = await asyncio.wait(
                [task, cancel_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_task in done:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise asyncio.CancelledError(cancellation_token.reason)
            return task.result()
        finally:
            if not cancel_task.done():
                cancel_task.cancel()
            await asyncio.gather(cancel_task, return_exceptions=True)

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
            "cwd": os.path.normcase(os.path.realpath(os.getcwd())),
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
