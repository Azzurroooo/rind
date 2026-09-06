"""OpenAI SDK client construction from an immutable settings snapshot."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

from agent.infrastructure.config.settings_loader import AppSettings


async def close_async_client(client: Any) -> None:
    """Close a provider client regardless of sync/async SDK variants."""
    close = getattr(client, "close", None)
    if not callable(close):
        return
    result = close()
    if inspect.isawaitable(result):
        await result


@dataclass(frozen=True, slots=True)
class OpenAIClientFactory:
    settings: AppSettings

    def create_async_client(self) -> AsyncOpenAI:
        return AsyncOpenAI(
            api_key=self.settings.api_key,
            base_url=self.settings.base_url,
            default_headers=self._default_headers(),
        )

    def _default_headers(self) -> dict[str, str] | None:
        if not self.settings.user_agent:
            return None
        return {"User-Agent": self.settings.user_agent}
