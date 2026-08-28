"""Compact boundary creation."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from collections.abc import Callable
from typing import Any

from agent.domain.cancellation import CancellationToken
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT
from agent.domain.errors import PersistenceError
from agent.prompts import build_compact_prompt

from .estimator import DEFAULT_CONTEXT_WINDOW_TOKENS
from .handoff import CompactionHandoffBuilder
from .token_usage import normalize_sampling_usage


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class CompactionService:
    """Build compact handoff records with LLM-first and deterministic fallback paths."""

    policy_version: str = "compact_boundary_v3"
    max_excerpt_chars: int = 2000
    max_compact_prompt_chars: int = 100000
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
            keep_recent_chars=self._keep_recent_chars(context_stats),
        )
        try:
            corpus = self.build_compression_corpus(context_messages)
            payload = json.dumps(corpus, ensure_ascii=False, sort_keys=True, default=str)
            response = await chat_client.create(
                messages=build_compact_prompt(self._limit_prompt_payload(payload)),
                tools=None,
                cancellation_token=cancellation_token,
            )
            content = self._assistant_content(response).strip()
            if not content:
                raise ValueError("compact model returned empty handoff")
            record["strategy"] = "llm_inline"
            record["handoff_message"] = {"role": "assistant", "content": content}
            reasoning = self._assistant_reasoning_content(response).strip()
            if reasoning:
                record["handoff_message"]["reasoning_content"] = reasoning
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
            if hasattr(exc, "status"):
                record["fallback_error"]["status"] = str(exc.status)

        self._append_active_plan_snapshot(record)
        try:
            return await session.persist_compaction(record)
        except Exception as exc:
            raise PersistenceError(
                f"Failed to persist compaction boundary: {exc}",
                code=type(exc).__name__,
            ) from exc

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
        keep_recent_chars: int = 0,
    ) -> dict[str, Any]:
        handoff_builder = CompactionHandoffBuilder(self.max_excerpt_chars)
        created = created_at or self._now()
        boundary_index = handoff_builder.latest_boundary_index(messages)
        source_start = boundary_index + 1 if boundary_index >= 0 else 0
        source_end = self._retention_cut(
            messages,
            source_start,
            tool_records or [],
            keep_recent_chars,
        )
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
        handoff_builder = CompactionHandoffBuilder(self.max_excerpt_chars)
        corpus: list[dict[str, Any]] = []
        for message in context_messages:
            if not isinstance(message, dict):
                continue
            if handoff_builder.is_boundary(message) or message.get("role") == "system":
                continue
            corpus.append(handoff_builder.strip_internal_fields(message))
        return corpus

    def _retention_cut(
        self,
        messages: list[dict[str, Any]],
        source_start: int,
        tool_records: list[dict[str, Any]],
        keep_recent_chars: int,
    ) -> int:
        units = self._conversation_units(messages, source_start)
        if not units:
            return len(messages)
        tool_sizes = {
            str(record.get("id")): len(str(record.get("model_content") or ""))
            for record in tool_records
            if isinstance(record, dict) and record.get("id")
        }
        if keep_recent_chars <= 0:
            return len(messages)

        retained_start, retained_end = units[-1]
        retained_size = self._unit_size(messages, retained_start, retained_end, tool_sizes)
        for unit_start, unit_end in reversed(units[:-1]):
            unit_size = self._unit_size(messages, unit_start, unit_end, tool_sizes)
            if retained_size + unit_size > keep_recent_chars:
                break
            retained_start = unit_start
            retained_size += unit_size
        return retained_start

    def _conversation_units(
        self,
        messages: list[dict[str, Any]],
        source_start: int,
    ) -> list[tuple[int, int]]:
        units: list[tuple[int, int]] = []
        index = source_start
        while index < len(messages):
            message = messages[index]
            if message.get("role") == "system":
                index += 1
                continue
            end = index + 1
            if message.get("role") == "assistant":
                call_ids = self._tool_call_ids(message)
                if call_ids:
                    pending = set(call_ids)
                    while end < len(messages) and pending:
                        candidate = messages[end]
                        if candidate.get("role") != "tool":
                            break
                        pending.discard(str(candidate.get("tool_call_id") or ""))
                        end += 1
            units.append((index, end))
            index = end
        return units

    def _unit_size(
        self,
        messages: list[dict[str, Any]],
        start: int,
        end: int,
        tool_sizes: dict[str, int],
    ) -> int:
        return sum(self._message_chars(message, tool_sizes) for message in messages[start:end])

    def _tool_call_ids(self, message: dict[str, Any]) -> list[str]:
        meta = message.get("meta")
        calls = meta.get("tool_calls") if isinstance(meta, dict) else message.get("tool_calls")
        if not isinstance(calls, list):
            return []
        return [
            str(call.get("id"))
            for call in calls
            if isinstance(call, dict) and call.get("id")
        ]

    def _message_chars(self, message: dict[str, Any], tool_chars: dict[str, int]) -> int:
        role = message.get("role")
        if role == "tool":
            return tool_chars.get(str(message.get("tool_call_id") or ""), len(str(message.get("content") or "")))
        size = len(str(message.get("content") or ""))
        size += len(str(message.get("reasoning_content") or ""))
        meta = message.get("meta")
        if isinstance(meta, dict):
            for tool_call in meta.get("tool_calls") or []:
                if isinstance(tool_call, dict):
                    size += len(str(tool_call.get("raw_args") or ""))
        return size

    def _keep_recent_chars(self, context_stats: dict[str, Any] | None) -> int:
        stats = context_stats if isinstance(context_stats, dict) else {}
        try:
            limit = int(stats.get("auto_compact_token_limit") or 0)
        except (TypeError, ValueError):
            return 0
        if limit <= 0:
            return 0
        # Keep one twelfth of the auto-compact limit; CJK-conservative chars per token.
        return limit // 12 * 3 // 2

    async def _load_raw_messages(self, session, fallback: list[dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            messages = await session.load_messages()
            if isinstance(messages, list):
                return [dict(item) for item in messages if isinstance(item, dict)]
        except Exception:
            logger.debug("Best-effort compaction message load failed.", exc_info=True)
        return [dict(item) for item in fallback if isinstance(item, dict)]

    async def _load_tool_records(self, session) -> list[dict[str, Any]]:
        try:
            records = await session.get_tool_records()
            if isinstance(records, list):
                return [dict(item) for item in records if isinstance(item, dict)]
        except Exception:
            logger.debug("Best-effort compaction tool-record load failed.", exc_info=True)
        return []

    async def _load_latest_compaction(self, session) -> dict[str, Any] | None:
        try:
            latest = await session.get_latest_compaction()
            return dict(latest) if isinstance(latest, dict) else None
        except Exception:
            logger.debug("Best-effort latest compaction load failed.", exc_info=True)
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
            logger.debug("Best-effort plan snapshot failed.", exc_info=True)
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

    def _assistant_reasoning_content(self, response: Any) -> str:
        choices = self._get(response, "choices")
        if isinstance(choices, list) and choices:
            message = self._get(choices[0], "message")
            reasoning = self._get(message, "reasoning_content")
            if isinstance(reasoning, str):
                return reasoning
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
        try:
            await session.persist_sampling_usage(usage)
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
