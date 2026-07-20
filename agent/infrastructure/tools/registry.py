"""Default tool registry adapter."""

from __future__ import annotations

import inspect
from typing import Any, Callable

from .impl import TOOLS, TOOL_SCHEMAS


class DefaultToolRegistry:
    """Adapter to expose tool implementations/schemas to application layer."""

    def __init__(self, tool_map: dict[str, Callable] | None = None, schemas: list[dict] | None = None):
        self._tool_map = tool_map or TOOLS
        self._schemas = schemas or TOOL_SCHEMAS

    @property
    def schemas(self) -> list[dict]:
        return self._schemas

    def has(self, name: str) -> bool:
        return name in self._tool_map

    def is_async(self, name: str) -> bool:
        """Return True if the tool is a coroutine function."""
        func = self._tool_map.get(name)
        return func is not None and inspect.iscoroutinefunction(func)

    def call(self, name: str, args: dict) -> Any:
        func = self._tool_map[name]
        return func(**self._filter_call_args(func, args))

    async def call_async(self, name: str, args: dict) -> Any:
        """Call an async tool and await the result."""
        func = self._tool_map[name]
        return await func(**self._filter_call_args(func, args))

    def _filter_call_args(self, func: Callable, args: dict) -> dict:
        signature = inspect.signature(func)
        if any(param.kind is inspect.Parameter.VAR_KEYWORD for param in signature.parameters.values()):
            return args
        return {key: value for key, value in args.items() if key in signature.parameters}
