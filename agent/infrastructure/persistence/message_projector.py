"""Project persisted session records into model messages."""

from __future__ import annotations

from typing import Any

from agent.application.services.message_boundary import validate_compact_handoff_boundary
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT


def project_messages(
    messages: list[dict[str, Any]],
    tool_records: list[dict[str, Any]],
    compactions: list[dict[str, Any]],
    system_prompt: str,
) -> list[dict[str, Any]]:
    compact_applied = latest_compact_pair(messages, compactions) is not None
    projected_messages = apply_latest_compact_boundary(messages, compactions)
    tool_map = {
        str(item["id"]): item
        for item in tool_records
        if isinstance(item, dict) and item.get("id")
    }

    built_messages: list[dict[str, Any]] = []
    emitted_tool_call_ids: set[str] = set()
    for message in projected_messages:
        if not isinstance(message, dict) or is_compact_boundary_message(message):
            continue
        role = message.get("role")
        if role == "tool":
            tool_call_id = message.get("tool_call_id")
            if tool_call_id and str(tool_call_id) in emitted_tool_call_ids:
                continue
            built_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": _build_tool_content(tool_map.get(str(tool_call_id))),
                }
            )
            if tool_call_id:
                emitted_tool_call_ids.add(str(tool_call_id))
            continue
        if role == "assistant" and _has_tool_calls_meta(message):
            tool_calls = _build_assistant_tool_calls(message["meta"]["tool_calls"], tool_map)
            if tool_calls:
                built_messages.append({"role": "assistant", "tool_calls": tool_calls})
                built_messages.extend(_missing_tool_messages(tool_calls, tool_map, emitted_tool_call_ids))
            if message.get("content"):
                built_messages.append({"role": "assistant", "content": message.get("content")})
            continue
        if role in {"system", "user", "assistant"}:
            built_messages.append({"role": role, "content": message.get("content", "")})

    if not built_messages:
        return [{"role": "system", "content": system_prompt}]
    if compact_applied:
        result = validate_compact_handoff_boundary(built_messages)
        if not result.ok:
            raise ValueError(f"Invalid compact continuation boundary: {result.reason}")
    return built_messages


def latest_compaction(
    messages: list[dict[str, Any]],
    compactions: list[dict[str, Any]],
) -> dict[str, Any] | None:
    matched = latest_compact_pair(messages, compactions)
    return matched[1] if matched else None


def latest_compact_pair(
    messages: list[dict[str, Any]],
    compactions: list[dict[str, Any]],
) -> tuple[int, dict[str, Any]] | None:
    by_id = {
        str(record.get("id")): record
        for record in compactions
        if isinstance(record, dict) and record.get("id") and _has_valid_handoff(record)
    }
    if not by_id:
        return None
    for index in range(len(messages) - 1, -1, -1):
        if not is_compact_boundary_message(messages[index]):
            continue
        meta = messages[index].get("meta")
        compact_id = meta.get("compact_id") if isinstance(meta, dict) else None
        record = by_id.get(str(compact_id)) if compact_id else None
        if record is not None:
            return index, dict(record)
    return None


def apply_latest_compact_boundary(
    messages: list[dict[str, Any]],
    compactions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    matched = latest_compact_pair(messages, compactions)
    if matched is None:
        return [dict(message) for message in messages]
    boundary_index, compaction = matched

    projected = [
        dict(message)
        for message in messages[:boundary_index]
        if message.get("role") == "system"
    ]
    projected.extend(_compact_replacement_boundary(compaction))
    projected.extend(
        dict(message)
        for message in messages[boundary_index + 1 :]
        if not is_compact_boundary_message(message)
    )
    return projected


def is_compact_boundary_message(message: dict[str, Any]) -> bool:
    meta = message.get("meta")
    return isinstance(meta, dict) and meta.get("kind") == "compact_boundary"


def _compact_replacement_boundary(compaction: dict[str, Any]) -> list[dict[str, Any]]:
    handoff = compaction["handoff_message"]
    content = handoff["content"]
    user = compaction.get("continuation_user_message")
    if not _valid_message(user, {"user"}):
        user = {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT}
    return [
        {"role": "user", "content": user["content"]},
        {"role": "assistant", "content": content},
    ]


def _valid_message(message: Any, allowed_roles: set[str]) -> bool:
    if not isinstance(message, dict):
        return False
    return message.get("role") in allowed_roles and isinstance(message.get("content"), str)


def _has_valid_handoff(record: dict[str, Any]) -> bool:
    handoff = record.get("handoff_message")
    if not isinstance(handoff, dict):
        return False
    role = handoff.get("role")
    content = handoff.get("content")
    return role == "assistant" and isinstance(content, str)


def _has_tool_calls_meta(message: dict[str, Any]) -> bool:
    meta = message.get("meta")
    return isinstance(meta, dict) and bool(meta.get("tool_calls"))


def _build_assistant_tool_calls(
    tool_calls_meta: list[dict[str, Any]],
    tool_map: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    for tc_meta in tool_calls_meta:
        tc_id = str(tc_meta.get("id") or "")
        tc_name = tc_meta.get("name") or ""
        if not tc_id:
            raise ValueError("Invalid tool call message: missing tool call id.")
        tc_record = tool_map.get(tc_id)
        raw_args = tc_record.get("raw_args") if isinstance(tc_record, dict) else ""
        if not raw_args:
            continue
        tool_calls.append(
            {"id": tc_id, "type": "function", "function": {"name": tc_name, "arguments": raw_args}}
        )
    return tool_calls


def _missing_tool_messages(
    tool_calls: list[dict[str, Any]],
    tool_map: dict[str, dict[str, Any]],
    emitted_tool_call_ids: set[str],
) -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    for tool_call in tool_calls:
        tool_call_id = str(tool_call.get("id") or "")
        if not tool_call_id or tool_call_id in emitted_tool_call_ids:
            continue
        content = _build_tool_content(tool_map.get(tool_call_id))
        missing.append({"role": "tool", "tool_call_id": tool_call_id, "content": content})
        emitted_tool_call_ids.add(tool_call_id)
    return missing


def _build_tool_content(tool_record: dict | None) -> str:
    if not tool_record:
        raise ValueError("Unsupported legacy tool record: missing tool call record.")
    model_content = tool_record.get("model_content")
    if isinstance(model_content, str) and model_content:
        return model_content
    raise ValueError("Unsupported legacy tool record: missing model_content.")
