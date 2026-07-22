"""Explicit errors used at application and infrastructure boundaries."""

from __future__ import annotations

from typing import Literal


FailureStatus = Literal["rejected", "failed", "timed_out", "unavailable"]
ToolEventStatus = Literal[
    "completed",
    "cancelled",
    "rejected",
    "failed",
    "timed_out",
    "unavailable",
]


class BoundaryError(RuntimeError):
    """An error classified at an application boundary."""

    source = "runtime"

    def __init__(
        self,
        message: str,
        *,
        status: FailureStatus = "failed",
        error_type: str | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.error_type = error_type or type(self).__name__
        self.code = code or ""


class ProviderError(BoundaryError):
    source = "provider"


class ToolBoundaryError(BoundaryError):
    source = "tool"


class PersistenceError(BoundaryError):
    source = "persistence"


class RenderingError(BoundaryError):
    source = "rendering"
