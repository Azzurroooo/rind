"""Domain helpers for standardized tool result payloads."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(slots=True)
class ToolExecutionResult:
    """Structured result for tool execution."""
    status: Literal["ok", "error", "cancelled"]
    result_str: str = ""
    error_msg: str = ""
    error_type: str = ""
    exit_code: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def tool_ok(tool: str, data: Any = None, meta: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"ok": True, "tool": tool, "data": data, "ts": _utc_now_iso()}
    if meta is not None:
        payload["meta"] = meta
    return json.dumps(payload, ensure_ascii=False)


def tool_error(
    tool: str,
    error: str,
    error_type: str | None = None,
    meta: dict[str, Any] | None = None,
) -> str:
    payload: dict[str, Any] = {"ok": False, "tool": tool, "error": error, "ts": _utc_now_iso()}
    if error_type:
        payload["error_type"] = error_type
    if meta is not None:
        payload["meta"] = meta
    return json.dumps(payload, ensure_ascii=False)


def tool_cancelled(tool: str, reason: str | None = None) -> str:
    normalized_reason = reason or "cancelled"
    return tool_error(
        tool,
        f"Tool cancelled: {normalized_reason}",
        "Cancelled",
        meta={"reason": normalized_reason},
    )
