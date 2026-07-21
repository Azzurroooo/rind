"""Compact boundary creation."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from collections.abc import Callable
from typing import Any

from agent.domain.cancellation import CancellationToken
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT

from .estimator import DEFAULT_CONTEXT_WINDOW_TOKENS
from .handoff import CompactionHandoffBuilder
from .token_usage import normalize_sampling_usage


@dataclass(slots=True)
class CompactionService:
    """Build compact handoff records with LLM-first and deterministic fallback paths."""

    policy_version: str = "compact_boundary_v3"
    max_excerpt_chars: int = 1200
    max_tool_lines: int = 20
    max_compact_prompt_chars: int = 60000
    plan_snapshot_provider: Callable[[], str] | None = None

    async def compact_async(
        self,
        session,
        context_messages: list[dict[str, Any]],
        chat_client,
        reason: str = "manual",
        phase: str = "manual",
        diagnostics: dict[str, Any] | None = None,
        context_stats: dict[str, Any] | None = None,
        cancellation_token: CancellationToken | None = None,
    ) -> dict[str, Any]:
        created_at = self._now()
        raw_messages = await self._load_raw_messages(session, context_messages)
        tool_records = await self._load_tool_records(session)
        previous = await self._load_latest_compaction(session)
        record = self.build_compaction(
            raw_messages,
            tool_records,
            previous_compaction=previous,
            created_at=created_at,
            reason=reason,
            phase=phase,
            diagnostics=diagnostics,
            handoff_messages=context_messages,
            strategy="deterministic_fallback",
        )
        try:
            response = await chat_client.create(
                messages=self._build_compact_prompt(self.build_compression_corpus(context_messages)),
                tools=None,
                cancellation_token=cancellation_token,
            )
            content = self._assistant_content(response).strip()
            if not content:
                raise ValueError("compact model returned empty handoff")
            record["strategy"] = "llm_inline"
            record["handoff_message"] = {"role": "assistant", "content": content}
            usage = self._sampling_usage(response, context_stats)
            if usage:
                record["usage"] = usage
                usage_error = await self._try_persist_sampling_usage(session, usage)
                if usage_error:
                    record["usage_persist_error"] = usage_error
        except Exception as exc:
            record["strategy"] = "deterministic_fallback"
            record["fallback_error"] = {
                "type": type(exc).__name__,
                "message": str(exc),
            }

        self._append_active_plan_snapshot(record)
        persist = getattr(session, "persist_compaction", None)
        if callable(persist):
            return await persist(record)
        return record

    def build_compaction(
        self,
        messages: list[dict[str, Any]],
        tool_records: list[dict[str, Any]] | None = None,
        previous_compaction: dict[str, Any] | None = None,
        created_at: str | None = None,
        reason: str = "manual",
        phase: str = "manual",
        diagnostics: dict[str, Any] | None = None,
        handoff_messages: list[dict[str, Any]] | None = None,
        strategy: str = "manual_deterministic",
    ) -> dict[str, Any]:
        handoff_builder = CompactionHandoffBuilder(self.max_excerpt_chars, self.max_tool_lines)
        created = created_at or self._now()
        boundary_index = handoff_builder.latest_boundary_index(messages)
        source_start = boundary_index + 1 if boundary_index >= 0 else 0
        source_end = len(messages)
        source_messages = [
            dict(message)
            for message in messages[source_start:source_end]
            if not handoff_builder.is_boundary(message)
        ]
        corpus_source = handoff_messages if handoff_messages is not None else source_messages
        corpus_messages = self.build_compression_corpus(corpus_source)
        previous_handoff = handoff_builder.previous_handoff(previous_compaction)
        tool_ids = handoff_builder.collect_tool_call_ids(corpus_messages)
        tool_lines = handoff_builder.render_tool_lines(tool_ids, tool_records or [])
        handoff = handoff_builder.render(previous_handoff, corpus_messages, tool_lines)

        source = {
            "message_start_index": source_start,
            "message_end_index_exclusive": source_end,
            "tool_call_ids": tool_ids,
            "history_digest": handoff_builder.digest(corpus_messages, previous_compaction),
        }

        record = {
            "id": uuid.uuid4().hex,
            "created_at": created,
            "strategy": strategy,
            "reason": reason,
            "phase": phase,
            "policy_version": self.policy_version,
            "source": source,
            "continuation_user_message": {
                "role": "user",
                "content": COMPACT_CONTINUATION_USER_CONTENT,
            },
            "handoff_message": {
                "role": "assistant",
                "content": handoff,
            },
            "usage": {},
        }
        if diagnostics:
            record["diagnostics"] = dict(diagnostics)
        return record

    def build_compression_corpus(self, context_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return compactable conversation facts, excluding instruction messages."""
        handoff_builder = CompactionHandoffBuilder(self.max_excerpt_chars, self.max_tool_lines)
        corpus: list[dict[str, Any]] = []
        for message in context_messages:
            if not isinstance(message, dict):
                continue
            if handoff_builder.is_boundary(message) or message.get("role") == "system":
                continue
            corpus.append(handoff_builder.strip_internal_fields(message))
        return corpus

    def _build_compact_prompt(self, corpus_messages: list[dict[str, Any]]) -> list[dict[str, str]]:
        payload = json.dumps(corpus_messages, ensure_ascii=False, sort_keys=True, default=str)
        payload = self._limit_prompt_payload(payload)
        system = (
            "You are compacting a coding-agent conversation into a source-bound handoff. "
            "Do not invent facts. Preserve concrete user goals, completed work, pending work, "
            "files, commands, tests, tool results, constraints, risks, and next steps. "
            "The handoff will replace the full prior context, so include any in-progress "
            "tool loop state and do not assume raw tool messages remain visible. Write concise Markdown."
        )
        user = (
            "Create a compact handoff for the following compression corpus. "
            "The handoff will replace the full prior context after a compact boundary. "
            "If a tool loop is in progress, summarize the tool call intent, tool result, "
            "and required continuation.\n\n"
            "Required sections:\n"
            "- Current goal\n"
            "- Completed work\n"
            "- Pending work\n"
            "- In-progress continuation state\n"
            "- Files, commands, and tests\n"
            "- Key tool results\n"
            "- User preferences and constraints\n"
            "- Risks and next checks\n\n"
            f"Compression corpus JSON:\n{payload}"
        )
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    async def _load_raw_messages(self, session, fallback: list[dict[str, Any]]) -> list[dict[str, Any]]:
        load = getattr(session, "load_messages", None)
        if callable(load):
            try:
                messages = await load()
                if isinstance(messages, list):
                    return [dict(item) for item in messages if isinstance(item, dict)]
            except Exception:
                pass
        return [dict(item) for item in fallback if isinstance(item, dict)]

    async def _load_tool_records(self, session) -> list[dict[str, Any]]:
        get_records = getattr(session, "get_tool_records", None)
        if callable(get_records):
            try:
                records = await get_records()
                if isinstance(records, list):
                    return [dict(item) for item in records if isinstance(item, dict)]
            except Exception:
                pass
        return []

    async def _load_latest_compaction(self, session) -> dict[str, Any] | None:
        get_latest = getattr(session, "get_latest_compaction", None)
        if callable(get_latest):
            try:
                latest = await get_latest()
                return dict(latest) if isinstance(latest, dict) else None
            except Exception:
                return None
        return None

    def _append_active_plan_snapshot(self, record: dict[str, Any]) -> None:
        snapshot = self._active_plan_snapshot()
        if not snapshot:
            return
        handoff = record.get("handoff_message")
        if not isinstance(handoff, dict):
            return
        content = handoff.get("content")
        if not isinstance(content, str):
            return
        handoff["content"] = content.rstrip() + "\n\nPlan state at compact boundary:\n" + snapshot

    def _active_plan_snapshot(self) -> str:
        if self.plan_snapshot_provider is None:
            return ""
        try:
            return str(self.plan_snapshot_provider() or "").strip()
        except Exception:
            return ""

    def _assistant_content(self, response: Any) -> str:
        output_text = getattr(response, "output_text", None)
        if isinstance(output_text, str):
            return output_text
        choices = self._get(response, "choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            message = self._get(first, "message")
            content = self._get(message, "content")
            if isinstance(content, str):
                return content
        return ""

    def _sampling_usage(self, response: Any, context_stats: dict[str, Any] | None) -> dict[str, Any] | None:
        stats = context_stats or {}
        context_window = self._positive_int(stats.get("context_window_tokens"), DEFAULT_CONTEXT_WINDOW_TOKENS)
        return normalize_sampling_usage(
            response,
            sampling_kind="compact",
            context_window_tokens=context_window,
        )

    def _positive_int(self, value: Any, default: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 else default

    async def _try_persist_sampling_usage(self, session, usage: dict[str, Any]) -> dict[str, str] | None:
        persist_usage = getattr(session, "persist_sampling_usage", None)
        if not callable(persist_usage):
            return None
        try:
            await persist_usage(usage)
        except Exception as exc:
            return {"type": type(exc).__name__, "message": str(exc)}
        return None

    def _limit_prompt_payload(self, payload: str) -> str:
        if len(payload) <= self.max_compact_prompt_chars:
            return payload
        half = max(1, (self.max_compact_prompt_chars - 44) // 2)
        return payload[:half].rstrip() + "\n[compact_prompt_truncated]\n" + payload[-half:].lstrip()

    def _get(self, value: Any, key: str) -> Any:
        if isinstance(value, dict):
            return value.get(key)
        return getattr(value, key, None)

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
