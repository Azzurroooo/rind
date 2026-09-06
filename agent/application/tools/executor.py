"""Application-level safe tool execution service."""

from __future__ import annotations

import asyncio
from typing import Any

from agent.application.ports.tool_registry import ToolRegistry
from agent.domain.errors import FailureStatus
from agent.domain.tool_result import ToolExecutionResult


class ToolExecutor:
    """Runs tool calls with standardized error handling."""

    def __init__(self, registry: ToolRegistry):
        self._registry = registry

    def is_async_tool(self, name: str) -> bool:
        """Return whether the named tool should be awaited directly."""
        return self._registry.is_async(name)

    def execute_sync(self, name: str, args: dict) -> ToolExecutionResult:
        """Synchronous execution returning a structured ToolExecutionResult."""
        if not self._registry.has(name):
            return _unavailable(name)
        try:
            return _completed(self._registry.call(name, args))
        except asyncio.CancelledError:
            raise
        except (TimeoutError, asyncio.TimeoutError) as exc:
            return _failed(exc, "timed_out")
        except TypeError as exc:
            return _failed(exc, "rejected")
        except Exception as exc:
            return _failed(exc, "failed")

    async def execute_async(self, name: str, args: dict) -> ToolExecutionResult:
        """Async execution for coroutine-based tools (e.g. bash)."""
        if not self._registry.has(name):
            return _unavailable(name)
        try:
            return _completed(await self._registry.call_async(name, args))
        except asyncio.CancelledError:
            raise
        except (TimeoutError, asyncio.TimeoutError) as exc:
            return _failed(exc, "timed_out")
        except TypeError as exc:
            return _failed(exc, "rejected")
        except Exception as exc:
            return _failed(exc, "failed")


def _completed(result: Any) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="ok",
        result_str=result if isinstance(result, str) else str(result),
    )


def _unavailable(name: str) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="error",
        error_msg=f"Unknown tool: {name}",
        error_type="ToolNotFound",
        failure_status="unavailable",
    )


def _failed(exc: Exception, failure_status: FailureStatus) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="error",
        error_msg=str(exc),
        error_type=type(exc).__name__,
        failure_status=failure_status,
    )
