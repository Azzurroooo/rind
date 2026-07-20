"""Domain helpers for tool payload parsing and validation."""

from __future__ import annotations

from dataclasses import dataclass
import json


@dataclass(slots=True)
class ParsedToolCall:
    """Normalized tool-call shape used by application services."""

    call_id: str
    name: str
    raw_args: str


def looks_like_tool_payload(value: str) -> bool:
    """Detect if a string is already a standardized tool payload."""
    if not value:
        return False
    text = value.lstrip()
    if not text.startswith("{"):
        return False
    try:
        obj = json.loads(text)
    except Exception:
        return False
    return isinstance(obj, dict) and "ok" in obj and "tool" in obj


def parse_tool_args(raw_args: str) -> tuple[dict, str | None]:
    """Parse tool args from JSON string."""
    if not raw_args:
        return {}, None
    try:
        obj = json.loads(raw_args)
    except Exception as exc:
        return {}, str(exc)
    if not isinstance(obj, dict):
        return {}, "Tool arguments must be a JSON object."
    return obj, None
