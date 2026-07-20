"""Asynchronous interface for language model providers."""

from __future__ import annotations

from typing import Any, Protocol, AsyncIterator
from agent.application.runtime.cancellation import CancellationToken


class AsyncChatClient(Protocol):
    """Protocol for asynchronous interaction with LLM providers."""

    async def create(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> Any:
        """
        Execute a single completion request asynchronously.
        Returns the provider-specific response object (e.g. ChatCompletion).
        """
        ...

    async def stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> AsyncIterator[Any]:
        """
        Execute a streaming completion request asynchronously.
        Yields provider-specific chunk objects (e.g. ChatCompletionChunk).
        """
        ...
