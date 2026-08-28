"""Deterministic compaction handoff construction."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class CompactionHandoffBuilder:
    max_excerpt_chars: int = 1200

    def render(self, previous_handoff: str, messages: list[dict[str, Any]], tool_lines: list[str]) -> str:
        last_user = self._last_content(messages, "user")
        last_assistant = self._last_content(messages, "assistant")
        last_reasoning = self._last_reasoning(messages)
        lines = [
            "Context compacted.",
            "This is a deterministic handoff generated from persisted session events.",
        ]
        if previous_handoff:
            lines.extend(["", "Previous compact handoff:", self._excerpt(previous_handoff)])
        if last_user:
            lines.extend(["", "Latest user message:", self._excerpt(last_user)])
        if last_assistant:
            lines.extend(["", "Latest assistant message:", self._excerpt(last_assistant)])
        if last_reasoning:
            lines.extend(["", "Latest assistant reasoning:", self._excerpt(last_reasoning)])
        if tool_lines:
            lines.extend(["", "Tool calls:", *tool_lines])
        if len(lines) == 2:
            lines.append("No prior conversational messages were available in the compacted range.")
        return "\n".join(lines)

    def render_tool_lines(self, tool_ids: list[str], tool_records: list[dict[str, Any]]) -> list[str]:
        records = {
            str(record.get("id")): record
            for record in tool_records
            if isinstance(record, dict) and record.get("id")
        }
        lines: list[str] = []
        for call_id in tool_ids:
            record = records.get(call_id, {})
            suffix = f", error_type={record.get('error_type')}" if record.get("error_type") else ""
            lines.append(f"- {call_id}: {record.get('name') or 'unknown'}, ok={record.get('ok')}{suffix}")
        return lines

    def collect_tool_call_ids(self, messages: list[dict[str, Any]]) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for message in messages:
            if message.get("role") == "tool":
                self._append_id(ordered, seen, message.get("tool_call_id"))
            meta = message.get("meta")
            if isinstance(meta, dict):
                self._collect_ids(ordered, seen, meta.get("tool_calls"))
            self._collect_ids(ordered, seen, message.get("tool_calls"))
        return ordered

    def latest_boundary_index(self, messages: list[dict[str, Any]]) -> int:
        for index in range(len(messages) - 1, -1, -1):
            if self.is_boundary(messages[index]):
                return index
        return -1

    def digest(self, messages: list[dict[str, Any]], previous_compaction: dict[str, Any] | None) -> str:
        payload = {
            "previous_compaction_id": (previous_compaction or {}).get("id"),
            "source_messages": messages,
        }
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha1(text.encode("utf-8")).hexdigest()

    @staticmethod
    def is_boundary(message: dict[str, Any]) -> bool:
        meta = message.get("meta")
        return isinstance(meta, dict) and meta.get("kind") == "compact_boundary"

    @staticmethod
    def strip_internal_fields(message: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in dict(message).items() if not key.startswith("_")}

    @staticmethod
    def previous_handoff(compaction: dict[str, Any] | None) -> str:
        if not isinstance(compaction, dict):
            return ""
        handoff = compaction.get("handoff_message")
        if not isinstance(handoff, dict):
            return ""
        content = handoff.get("content")
        return content if isinstance(content, str) else ""

    def _collect_ids(self, ordered: list[str], seen: set[str], tool_calls: Any) -> None:
        if not isinstance(tool_calls, list):
            return
        for item in tool_calls:
            if isinstance(item, dict):
                self._append_id(ordered, seen, item.get("id"))

    @staticmethod
    def _append_id(ordered: list[str], seen: set[str], call_id: Any) -> None:
        if not call_id:
            return
        text = str(call_id)
        if text not in seen:
            seen.add(text)
            ordered.append(text)

    @staticmethod
    def _last_content(messages: list[dict[str, Any]], role: str) -> str:
        for message in reversed(messages):
            if message.get("role") != role or (role == "assistant" and message.get("tool_calls")):
                continue
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content
        return ""

    @staticmethod
    def _last_reasoning(messages: list[dict[str, Any]]) -> str:
        for message in reversed(messages):
            if message.get("role") != "assistant":
                continue
            reasoning = message.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning.strip():
                return reasoning
        return ""

    def _excerpt(self, text: str) -> str:
        if len(text) <= self.max_excerpt_chars:
            return text
        half = max(1, (self.max_excerpt_chars - 42) // 2)
        return text[:half].rstrip() + "\n[excerpt_truncated]\n" + text[-half:].lstrip()
