"""Application-level safe tool execution service."""

from __future__ import annotations

import traceback

from agent.application.ports import ToolRegistry
from agent.domain.tool_result import ToolExecutionResult


class ToolExecutor:
    """Runs tool calls with standardized error handling."""

    def __init__(self, registry: ToolRegistry):
        self._registry = registry

    def is_async_tool(self, name: str) -> bool:
        """Return whether the named tool should be awaited directly."""
        return self._registry.is_async(name)

    def execute_sync(self, name: str, args: dict, raw_args: str | None = None) -> ToolExecutionResult:
        """Synchronous execution returning a structured ToolExecutionResult."""
        if not self._registry.has(name):
            return ToolExecutionResult(
                status="error",
                error_msg=f"Unknown tool: {name}",
                error_type="ToolNotFound"
            )
        try:
            result = self._registry.call(name, args)
            return ToolExecutionResult(
                status="ok",
                result_str=result if isinstance(result, str) else str(result)
            )
        except TypeError as exc:
            meta = {"raw_args": (raw_args or "")[:2000]} if raw_args else {}
            return ToolExecutionResult(
                status="error",
                error_msg=str(exc),
                error_type=type(exc).__name__,
                metadata=meta
            )
        except Exception as exc:
            meta = {"traceback": traceback.format_exc()[-4000:]}
            if raw_args:
                meta["raw_args"] = raw_args[:2000]
            return ToolExecutionResult(
                status="error",
                error_msg=str(exc),
                error_type=type(exc).__name__,
                metadata=meta
            )

    async def execute_async(self, name: str, args: dict, raw_args: str | None = None) -> ToolExecutionResult:
        """Async execution for coroutine-based tools (e.g. bash)."""
        if not self._registry.has(name):
            return ToolExecutionResult(
                status="error",
                error_msg=f"Unknown tool: {name}",
                error_type="ToolNotFound"
            )
        try:
            result = await self._registry.call_async(name, args)
            return ToolExecutionResult(
                status="ok",
                result_str=result if isinstance(result, str) else str(result)
            )
        except TypeError as exc:
            meta = {"raw_args": (raw_args or "")[:2000]} if raw_args else {}
            return ToolExecutionResult(
                status="error",
                error_msg=str(exc),
                error_type=type(exc).__name__,
                metadata=meta
            )
        except Exception as exc:
            meta = {"traceback": traceback.format_exc()[-4000:]}
            if raw_args:
                meta["raw_args"] = raw_args[:2000]
            return ToolExecutionResult(
                status="error",
                error_msg=str(exc),
                error_type=type(exc).__name__,
                metadata=meta
            )
