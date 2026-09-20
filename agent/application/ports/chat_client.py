"""Asynchronous interface for language model providers."""

from __future__ import annotations

from typing import Protocol, AsyncIterator
from agent.domain.cancellation import CancellationToken
from agent.domain.models import ModelCompletion, ModelStreamEvent


class ChatClient(Protocol):
    """Protocol for asynchronous interaction with LLM providers."""

    async def close(self) -> None:
        """Release the provider's connections and resources."""
        ...

    async def create(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
        *,
        max_output_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> ModelCompletion:
        """Complete with a request-local output cap and supported reasoning override."""
        ...

    async def stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> AsyncIterator[ModelStreamEvent]:
        """Stream provider-neutral model events."""
        ...
