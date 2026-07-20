"""Tool registry port for application services."""

from __future__ import annotations

from typing import Any, Protocol


class ToolRegistry(Protocol):
    @property
    def schemas(self) -> list[dict]: ...

    def has(self, name: str) -> bool: ...

    def is_async(self, name: str) -> bool: ...

    def call(self, name: str, args: dict[str, Any]) -> Any: ...

    async def call_async(self, name: str, args: dict[str, Any]) -> Any: ...
