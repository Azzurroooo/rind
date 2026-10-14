"""Domain helpers for standardized tool result payloads."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from dataclasses import dataclass, field
from typing import Any, Literal

from .errors import FailureStatus, ToolEventStatus
from .images import ImageAttachment


@dataclass(slots=True)
class ToolExecutionResult:
    """Structured result for tool execution."""
    status: Literal["ok", "error", "cancelled"]
    result_str: str = ""
    error_msg: str = ""
    error_type: str = ""
    failure_status: FailureStatus | None = None
    exit_code: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def tool_ok(tool: str, data: Any = None, meta: dict[str, Any] | None = None, *, attachments: list[ImageAttachment] | None = None) -> str:
    payload: dict[str, Any] = {"ok": True, "tool": tool, "data": data, "ts": _utc_now_iso()}
    if meta is not None:
        payload["meta"] = meta
    if attachments:
        payload["attachments"] = attachments
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


def parse_tool_result_payload(value: Any) -> dict | None:
    if isinstance(value, dict):
        return value if "ok" in value and "tool" in value else None
    if not isinstance(value, str) or not value or not value.lstrip().startswith("{"):
        return None
    try:
        payload = json.loads(value)
    except (TypeError, ValueError):
        return None
    if isinstance(payload, dict) and "ok" in payload and "tool" in payload:
        return payload
    return None


def classify_tool_payload(payload: dict) -> tuple[ToolEventStatus, str] | None:
    if payload.get("ok") is False:
        error_type = payload.get("error_type")
        if not isinstance(error_type, str) or not error_type:
            error_type = "ToolExecutionError"
        return classify_tool_error(error_type), error_type
    data = payload.get("data")
    status = data.get("status") if isinstance(data, dict) else None
    if status == "cancelled":
        return "cancelled", "Cancelled"
    if status == "timed_out":
        return "timed_out", "Timeout"
    if status in {"lost", "failed"}:
        return "failed", "TaskLost" if status == "lost" else "ToolExecutionError"
    return None


def classify_tool_error(error_type: str) -> ToolEventStatus:
    normalized = error_type.lower()
    if normalized == "cancelled":
        return "cancelled"
    if normalized in {"toolnotfound", "notfound", "userquestionunsupported"}:
        return "unavailable"
    if "timeout" in normalized or normalized in {"deadlineexceeded"}:
        return "timed_out"
    if normalized in {"toolargsjsonerror", "invalidarguments", "invaliduserquestion", "typeerror", "valueerror"}:
        return "rejected"
    return "failed"
