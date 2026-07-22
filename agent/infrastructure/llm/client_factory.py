"""OpenAI SDK client construction from an immutable settings snapshot."""

from __future__ import annotations

from dataclasses import dataclass

from openai import AsyncOpenAI, OpenAI

from agent.infrastructure.config.settings_loader import AppSettings


@dataclass(frozen=True, slots=True)
class OpenAIClientFactory:
    settings: AppSettings

    def create_client(self) -> OpenAI:
        return OpenAI(
            api_key=self.settings.api_key,
            base_url=self.settings.base_url,
            default_headers=self._default_headers(),
        )

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
