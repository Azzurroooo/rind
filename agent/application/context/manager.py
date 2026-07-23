"""Context construction service for model-facing conversation state."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from agent.domain.skills import render_active_skill_instructions
from agent.domain.errors import PersistenceError

from .estimator import ContextEstimator


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ContextBuildResult:
    """Result of building messages for a model request."""

    messages: list[dict]
    stats: dict = field(default_factory=dict)
    decisions: dict = field(default_factory=dict)


class ContextManager:
    """Builds the model-facing message list from persisted session state."""

    def __init__(
        self,
        estimator: ContextEstimator | None = None,
        hot_message_limit: int = 6,
        skill_repository=None,
        skill_selector=None,
        active_skill_char_limit: int = 12000,
        rind_doc_provider=None,
    ):
        self._estimator = estimator or ContextEstimator()
        self._hot_message_limit = max(1, int(hot_message_limit))
        self._skill_repository = skill_repository
        self._skill_selector = skill_selector
        self._active_skill_char_limit = max(0, int(active_skill_char_limit))
        self._rind_doc_provider = rind_doc_provider

    async def build_messages_async(
        self,
        session,
        pending_messages: list[dict] | None = None,
        active_skill_matches: list | None = None,
        transient_system_messages: list[dict] | None = None,
        allow_rescue: bool = False,
    ) -> ContextBuildResult:
        try:
            persisted_messages = [dict(message) for message in await session.get_messages_slice()]
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise PersistenceError(
                f"Failed to load session messages: {exc}",
                error_type=type(exc).__name__,
            ) from exc
        pending = [dict(message) for message in (pending_messages or [])]
        budget = self._estimator.budget
        full_messages = persisted_messages + pending
        rind_messages, rind_stats, rind_decisions = self._build_rind_doc_messages()
        skill_messages, skill_stats, skill_decisions = self._build_skill_messages(active_skill_matches)
        extra_system_messages = (
            rind_messages
            + self._valid_system_messages(transient_system_messages)
            + skill_messages
        )
        if extra_system_messages:
            full_messages = self._insert_after_first_system(full_messages, extra_system_messages)

        messages = list(full_messages)
        hot_message_count = min(
            self._hot_message_limit,
            len([message for message in full_messages if self._is_conversation_message(message)]),
        )

        final_messages = [self._strip_internal_fields(message) for message in messages]
        final_estimate = self._estimator.estimate_messages(final_messages)

        dropped_count = 0
        while allow_rescue and final_estimate.over_hard_limit and len(final_messages) > 2:
            messages, final_messages = self.rescue_context(messages, final_messages)
            final_estimate = self._estimator.estimate_messages(final_messages)
            dropped_count += 1
            if dropped_count > 50:
                break

        tool_messages = [dict(message) for message in final_messages if message.get("role") == "tool"]
        auto_compact_status = await self._build_token_pressure_status(session, final_estimate)
        context_window_tokens = budget.resolved_context_window_tokens()
        context_usage_percent = final_estimate.estimated_input_tokens / max(1, context_window_tokens)

        stats = {
            "message_count": len(messages),
            "persisted_message_count": len(persisted_messages),
            "pending_message_count": len(pending),
            "tool_message_count": len(tool_messages),
            "hot_message_count": hot_message_count,
            "estimated_input_tokens": final_estimate.estimated_input_tokens,
            "estimated_chars": final_estimate.estimated_chars,
            "system_tokens": final_estimate.system_tokens,
            "conversation_tokens": final_estimate.conversation_tokens,
            "tool_tokens": final_estimate.tool_tokens,
            "context_window_tokens": context_window_tokens,
            "auto_compact_token_limit_percent": budget.resolved_auto_compact_token_limit_percent(),
            "auto_compact_token_limit": budget.resolved_auto_compact_token_limit(),
            "context_usage_percent": context_usage_percent,
            "budget": budget.to_dict(),
            **auto_compact_status,
            **rind_stats,
            **skill_stats,
        }
        decisions = {
            "mode": "session_backed",
            "source": "session_queries",
            "uses_pending_overlay": bool(pending),
            "over_conversation_budget": final_estimate.conversation_tokens >= budget.conversation_budget_tokens,
            "over_tool_budget": final_estimate.tool_tokens >= budget.tool_budget_tokens,
            "over_system_budget": final_estimate.system_tokens >= budget.system_budget_tokens,
            "compact_required": final_estimate.over_hard_limit,
            "auto_compact_token_limit_reached": auto_compact_status["auto_compact_token_limit_reached"],
            **rind_decisions,
            **skill_decisions,
        }
        return ContextBuildResult(messages=final_messages, stats=stats, decisions=decisions)

    async def _build_token_pressure_status(self, session, final_estimate) -> dict:
        budget = self._estimator.budget
        compact_generation = await self._get_compact_generation(session)
        usage = await self._get_latest_assistant_sampling_usage(session)
        anchor = self._resolve_usage_anchor(
            usage=usage,
            current_tokens=final_estimate.estimated_input_tokens,
            compact_generation=compact_generation,
            model=_session_model(session),
        )

        if anchor["usable"]:
            local_delta = max(0, final_estimate.estimated_input_tokens - anchor["local_estimated_input_tokens"])
            active_tokens = anchor["server_input_tokens"] + local_delta
            token_source = "assistant_usage_plus_local_delta"
        else:
            local_delta = 0
            active_tokens = final_estimate.estimated_input_tokens
            token_source = "local_estimate"

        limit = budget.resolved_auto_compact_token_limit()
        reached = bool(budget.auto_compact_enabled and active_tokens >= limit)
        return {
            "auto_compact_enabled": bool(budget.auto_compact_enabled),
            "auto_compact_token_limit_reached": reached,
            "auto_compact_active_tokens": active_tokens,
            "auto_compact_token_source": token_source,
            "auto_compact_compact_generation": compact_generation,
            "auto_compact_anchor_usable": bool(anchor["usable"]),
            "auto_compact_anchor_fallback_reason": anchor["fallback_reason"],
            "auto_compact_anchor_input_tokens": anchor["server_input_tokens"],
            "auto_compact_anchor_local_estimated_input_tokens": anchor["local_estimated_input_tokens"],
            "auto_compact_anchor_compact_generation": anchor["compact_generation"],
            "auto_compact_anchor_model": anchor["model"],
            "auto_compact_anchor_model_status": anchor["model_status"],
            "auto_compact_local_delta_tokens": local_delta,
        }

    async def _get_compact_generation(self, session) -> int:
        try:
            generation = self._positive_int_or_none(await session.get_compact_generation())
            if generation is not None:
                return generation
        except Exception:
            logger.debug("Best-effort compact generation lookup failed.", exc_info=True)
        return 1

    def _resolve_usage_anchor(
        self,
        *,
        usage: dict,
        current_tokens: int,
        compact_generation: int,
        model,
    ) -> dict:
        result = {
            "usable": False,
            "fallback_reason": None,
            "server_input_tokens": None,
            "local_estimated_input_tokens": None,
            "compact_generation": None,
            "model": None,
            "model_status": None,
        }
        if not usage:
            result["fallback_reason"] = "missing_usage"
            return result
        if usage.get("sampling_kind") != "assistant":
            result["fallback_reason"] = "non_assistant_usage"
            return result
        server_input_tokens = self._positive_int_or_none(usage.get("input_tokens"))
        if server_input_tokens is None:
            result["fallback_reason"] = "invalid_server_input_tokens"
            return result
        anchor = usage.get("anchor")
        if not isinstance(anchor, dict):
            result["fallback_reason"] = "missing_anchor"
            result["server_input_tokens"] = server_input_tokens
            return result

        local_estimate = self._positive_int_or_none(anchor.get("local_estimated_input_tokens"))
        anchor_generation = self._positive_int_or_none(anchor.get("compact_generation"))
        anchor_model = self._clean_text(anchor.get("model"))
        current_model = self._clean_text(model)
        result.update(
            {
                "server_input_tokens": server_input_tokens,
                "local_estimated_input_tokens": local_estimate,
                "compact_generation": anchor_generation,
                "model": anchor_model,
            }
        )
        if local_estimate is None:
            result["fallback_reason"] = "invalid_anchor_local_estimate"
            return result
        if anchor_generation != compact_generation:
            result["fallback_reason"] = "compact_generation_mismatch"
            return result
        if int(current_tokens) < local_estimate:
            result["fallback_reason"] = "current_estimate_below_anchor"
            return result
        if anchor_model and current_model and anchor_model != current_model:
            result["fallback_reason"] = "model_mismatch"
            result["model_status"] = "mismatch"
            return result

        result["usable"] = True
        result["model_status"] = "matched" if anchor_model and current_model else "anchor_model_unknown"
        return result

    async def _get_latest_assistant_sampling_usage(self, session) -> dict:
        try:
            usage = await session.get_latest_assistant_sampling_usage()
            if isinstance(usage, dict):
                return dict(usage)
        except Exception:
            logger.debug("Best-effort sampling usage lookup failed.", exc_info=True)
        return {}

    def _positive_int_or_none(self, value) -> int | None:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    def _clean_text(self, value) -> str | None:
        if not isinstance(value, str):
            return None
        clean = value.strip()
        return clean or None

    def reduce_hard_limit(self, factor: float = 0.8) -> int:
        """Reduce the hard token limit by a factor and return the new value."""
        budget = self._estimator.budget
        budget.hard_limit_tokens = int(budget.resolved_hard_limit_tokens() * factor)
        return budget.resolved_hard_limit_tokens()

    def snapshot_hard_limit(self):
        return self._estimator.budget.hard_limit_tokens

    def restore_hard_limit(self, hard_limit) -> None:
        self._estimator.budget.hard_limit_tokens = hard_limit

    def rescue_context(self, internal_messages: list[dict], final_messages: list[dict]) -> tuple[list[dict], list[dict]]:
        """Surgical Context Rescue: Drops the oldest cold/tool messages instead of blindly shrinking budgets."""
        # Find oldest non-system message that isn't already dropped
        target_idx = -1
        for i, msg in enumerate(final_messages):
            if msg.get("role") != "system" and msg.get("content") != "[DROPPED FOR CONTEXT RESCUE]":
                # Do not drop the very last few hot messages
                if i < len(final_messages) - 2:
                    target_idx = i
                    break

        if target_idx != -1:
            internal_messages[target_idx]["content"] = "[DROPPED FOR CONTEXT RESCUE]"
            final_messages[target_idx]["content"] = "[DROPPED FOR CONTEXT RESCUE]"

        return internal_messages, final_messages

    def _strip_internal_fields(self, message: dict) -> dict:
        return {key: value for key, value in dict(message).items() if not key.startswith("_")}

    def select_active_skills_for_turn(self, user_message: str) -> list:
        if not self._skill_repository or not self._skill_selector:
            return []
        try:
            skills = list(self._skill_repository.list_skills())
            return list(self._skill_selector.select(user_message, skills))
        except Exception:
            logger.debug("Best-effort skill selection failed.", exc_info=True)
            return []

    def _build_rind_doc_messages(self) -> tuple[list[dict], dict, dict]:
        stats = {
            "rind_docs_user_exists": False,
            "rind_docs_project_exists": False,
            "rind_docs_user_bytes": 0,
            "rind_docs_project_bytes": 0,
            "rind_docs_user_injected_bytes": 0,
            "rind_docs_project_injected_bytes": 0,
            "rind_docs_injected_chars": 0,
        }
        decisions = {
            "rind_docs_injected": False,
            "rind_docs_truncated": False,
            "rind_docs_truncated_scopes": [],
            "rind_docs_user_path": None,
            "rind_docs_project_path": None,
            "rind_docs_error_type": None,
        }
        if not self._rind_doc_provider:
            return [], stats, decisions
        try:
            messages, provider_stats, provider_decisions = self._rind_doc_provider()
        except Exception as exc:
            decisions["rind_docs_error_type"] = type(exc).__name__
            return [], stats, decisions
        stats.update(provider_stats if isinstance(provider_stats, dict) else {})
        decisions.update(provider_decisions if isinstance(provider_decisions, dict) else {})
        return self._valid_system_messages(messages), stats, decisions

    def _build_skill_messages(self, active_skill_matches: list | None = None) -> tuple[list[dict], dict, dict]:
        stats = {
            "skill_count": 0,
            "active_skill_count": 0,
            "skill_index_chars": 0,
            "active_skill_chars": 0,
        }
        decisions = {
            "skills_available": False,
            "active_skills": [],
            "skill_injection_applied": False,
            "skill_error_type": None,
        }
        if not self._skill_repository:
            return [], stats, decisions

        try:
            skills = list(self._skill_repository.list_skills())
        except Exception as exc:
            decisions["skill_error_type"] = type(exc).__name__
            return [], stats, decisions
        if not skills:
            return [], stats, decisions

        active_matches = list(active_skill_matches or [])
        messages: list[dict] = []

        active_content = ""
        if active_matches:
            active_content = render_active_skill_instructions(active_matches, self._active_skill_char_limit)
            if active_content:
                messages.append(
                    {
                        "role": "system",
                        "content": active_content,
                        "_context_kind": "skill_instruction",
                    }
                )

        stats.update(
            {
                "skill_count": len(skills),
                "active_skill_count": len(active_matches),
                "skill_index_chars": 0,
                "active_skill_chars": len(active_content),
            }
        )
        decisions.update(
            {
                "skills_available": True,
                "active_skills": [
                    {
                        "name": match.skill.name,
                        "reason": match.reason,
                        "score": match.score,
                        "source": match.skill.source,
                        "path": match.skill.path,
                    }
                    for match in active_matches
                ],
                "skill_injection_applied": bool(messages),
            }
        )
        return messages, stats, decisions

    def _valid_system_messages(self, messages: list[dict] | None) -> list[dict]:
        valid = []
        for message in messages or []:
            if not isinstance(message, dict) or message.get("role") != "system":
                continue
            content = message.get("content")
            if isinstance(content, str):
                valid.append(dict(message))
        return valid

    def _insert_after_first_system(self, messages: list[dict], extra_messages: list[dict]) -> list[dict]:
        if not extra_messages:
            return list(messages)
        result: list[dict] = []
        inserted = False
        for message in messages:
            result.append(dict(message))
            if not inserted and message.get("role") == "system":
                result.extend(dict(item) for item in extra_messages)
                inserted = True
        if not inserted:
            result = [dict(item) for item in extra_messages] + result
        return result

    def _mark_context_kind(self, messages: list[dict], kind: str) -> list[dict]:
        marked = []
        for message in messages or []:
            if not isinstance(message, dict):
                continue
            item = dict(message)
            item.setdefault("_context_kind", kind)
            marked.append(item)
        return marked

    def _insert_before_latest_user(self, messages: list[dict], extra_messages: list[dict]) -> list[dict]:
        if not extra_messages:
            return list(messages)
        result = [dict(message) for message in messages]
        insert_at = None
        for index in range(len(result) - 1, -1, -1):
            if result[index].get("role") == "user":
                insert_at = index
                break
        rendered_extra = [dict(item) for item in extra_messages]
        if insert_at is None:
            prefix_end = 0
            while prefix_end < len(result) and result[prefix_end].get("role") == "system":
                prefix_end += 1
            return result[:prefix_end] + rendered_extra + result[prefix_end:]
        return result[:insert_at] + rendered_extra + result[insert_at:]

    def _is_conversation_message(self, message: dict) -> bool:
        if message.get("role") not in {"user", "assistant"}:
            return False
        if message.get("tool_calls"):
            return False
        content = message.get("content", "")
        return isinstance(content, str) and bool(content.strip())


def _session_model(session) -> str | None:
    try:
        return session.model
    except AttributeError:
        return None
