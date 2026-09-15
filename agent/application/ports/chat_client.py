"""Asynchronous interface for language model providers."""

from __future__ import annotations

from typing import Protocol, AsyncIterator
from agent.domain.cancellation import CancellationToken
from agent.domain.models import ModelCompletion, ModelStreamEvent


class ChatClient(Protocol):
    """Protocol for asynchronous interaction with LLM providers."""

    async def create(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> ModelCompletion:
        """Execute one provider-neutral completion request."""
        ...

    async def stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> AsyncIterator[ModelStreamEvent]:
        """Stream provider-neutral model events."""
        ...
