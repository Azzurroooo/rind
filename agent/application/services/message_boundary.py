"""Validation for model message role boundaries."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class BoundaryValidationResult:
    ok: bool
    reason: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)


def validate_model_message_boundary(messages: list[dict[str, Any]]) -> BoundaryValidationResult:
    """Validate a model-bound Chat Completions message sequence."""
    if not isinstance(messages, list):
        return _invalid("messages_not_list")

    seen_non_system = False
    seen_user = False
    pending_tool_calls: set[str] = set()

    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            return _invalid("message_not_dict", index=index)
        role = message.get("role")
        if role == "system":
            if seen_non_system:
                return _invalid("system_after_conversation", index=index)
            continue

        seen_non_system = True
        if role == "user":
            if pending_tool_calls:
                return _invalid("assistant_tool_calls_missing_results", index=index)
            seen_user = True
            continue

        if role == "assistant":
            if not seen_user:
                return _invalid("assistant_before_user", index=index)
            if pending_tool_calls:
                return _invalid("assistant_tool_calls_missing_results", index=index)
            tool_call_ids = _tool_call_ids(message.get("tool_calls"))
            if tool_call_ids:
                pending_tool_calls.update(tool_call_ids)
            continue

        if role == "tool":
            if not seen_user:
                return _invalid("tool_before_user", index=index)
            tool_call_id = _clean_id(message.get("tool_call_id"))
            if not tool_call_id:
                return _invalid("tool_missing_tool_call_id", index=index)
            if tool_call_id not in pending_tool_calls:
                return _invalid("tool_without_matching_assistant_call", index=index, tool_call_id=tool_call_id)
            pending_tool_calls.remove(tool_call_id)
            continue

        return _invalid("unsupported_role", index=index, role=role)

    if not seen_user:
        return _invalid("missing_user_message")
    if pending_tool_calls:
        return _invalid("assistant_tool_calls_missing_results", tool_call_ids=sorted(pending_tool_calls))
    return BoundaryValidationResult(ok=True)


def validate_compact_handoff_boundary(messages: list[dict[str, Any]]) -> BoundaryValidationResult:
    """Validate a compact replacement with a stable user-to-assistant handoff."""
    result = validate_model_message_boundary(messages)
    if not result.ok:
        return result

    first = _first_non_system_index(messages)
    if first is None or first + 1 >= len(messages):
        return _invalid("missing_compact_handoff_pair")
    user = messages[first]
    assistant = messages[first + 1]
    if user.get("role") != "user":
        return _invalid("compact_handoff_missing_user", index=first)
    if assistant.get("role") != "assistant" or assistant.get("tool_calls"):
        return _invalid("compact_handoff_missing_assistant", index=first + 1)
    content = assistant.get("content")
    if not isinstance(content, str):
        return _invalid("compact_handoff_assistant_content_invalid", index=first + 1)
    return BoundaryValidationResult(ok=True)


def _first_non_system_index(messages: list[dict[str, Any]]) -> int | None:
    for index, message in enumerate(messages):
        if isinstance(message, dict) and message.get("role") != "system":
            return index
    return None


def _tool_call_ids(tool_calls: Any) -> list[str]:
    if not isinstance(tool_calls, list):
        return []
    ids: list[str] = []
    for item in tool_calls:
        if isinstance(item, dict):
            tool_id = _clean_id(item.get("id"))
            if tool_id:
                ids.append(tool_id)
    return ids


def _clean_id(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _invalid(reason: str, **detail: Any) -> BoundaryValidationResult:
    return BoundaryValidationResult(ok=False, reason=reason, detail=detail)
