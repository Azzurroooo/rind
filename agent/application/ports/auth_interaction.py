"""Transport-neutral interaction used by provider authentication flows."""

from __future__ import annotations

from typing import Protocol, Sequence


class AuthInteraction(Protocol):
    async def prompt(self, kind: str, message: str, options: Sequence[str] | None = None) -> str: ...

    def notify(self, event: dict) -> None: ...
