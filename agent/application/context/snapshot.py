"""Context composition snapshot derived from the real assembly result."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from agent.domain.compaction import (
    COMPACT_CONTINUATION_USER_CONTENT,
    COMPACT_HANDOFF_REASONING_CONTENT,
)

from .estimator import DEFAULT_CONTEXT_WINDOW_TOKENS, ContextEstimator
from .token_usage import positive_int


TOOL_ROW_LIMIT = 5
RIND_DOC_USER_MARKER = "--- user-doc ---"
RIND_DOC_PROJECT_MARKER = "--- project-doc ---"

_CONTEXT_KIND_LABELS = {
    "skill_catalog": "Skill catalog",
    "goal_policy": "Goal policy",
    "delegate": "Delegate instruction",
    "team_agent_catalog": "Team agent catalog",
    "rind_init": "RIND init",
}


def build_context_snapshot(
    messages: list[dict],
    stats: dict,
    turn_id: str = "",
    *,
    captured_at: str | None = None,
    estimator: ContextEstimator | None = None,
) -> dict[str, Any]:
    """Bucket the assembled message list into sections with estimated tokens.

    Pure function: fixed input produces the same sections. The total is taken
    from the pipeline's own stats (never re-summed), so per-section estimates
    share the exact per-message payloads the estimator scored at build time.
    """
    stats = stats if isinstance(stats, dict) else {}
    sections = _build_sections(messages, estimator or ContextEstimator())
    estimated_total = positive_int(stats.get("estimated_input_tokens"))
    if estimated_total is None:
        estimated_total = sum(section["tokens"] for section in sections)
    return {
        "captured_at": captured_at or datetime.now(timezone.utc).isoformat(),
        "turn_id": str(turn_id or ""),
        "estimated_total": estimated_total,
        "context_window_tokens": positive_int(
            stats.get("context_window_tokens"),
            DEFAULT_CONTEXT_WINDOW_TOKENS,
        ),
        "sections": sorted(sections, key=lambda section: (-section["tokens"], section["key"])),
    }


def _build_sections(messages: list[dict], estimator: ContextEstimator) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}

    def assign(key: str, label: str, tokens: int) -> None:
        bucket = buckets.get(key)
        if bucket is None:
            bucket = {"key": key, "label": label, "tokens": 0, "messages": 0}
            buckets[key] = bucket
        bucket["tokens"] += max(0, int(tokens))
        bucket["messages"] += 1

    tool_names = _tool_names_by_call_id(messages)
    top_tools = _top_tool_names(messages, tool_names)
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        kind = message.get("_context_kind")
        if isinstance(kind, str) and kind.strip():
            _assign_context_kind(assign, message, kind.strip(), estimator)
            continue
        role = message.get("role")
        if role == "tool":
            name = tool_names.get(str(message.get("tool_call_id") or "")) or "unknown"
            if name in top_tools:
                assign(f"tool:{name}", f"Tool results · {name}", _estimate(estimator, message))
            else:
                assign("tool:other", "Tool results · other", _estimate(estimator, message))
            continue
        if _is_compaction_handoff(message):
            assign("compaction_handoff", "Compaction handoff", _estimate(estimator, message))
            continue
        if role == "system":
            assign("system_prompt", "System prompt (incl. capsule)", _estimate(estimator, message))
        elif role == "user":
            assign("chat_user", "Chat · user inputs", _estimate(estimator, message))
        elif role == "assistant":
            _assign_assistant(assign, message, estimator)
        else:
            # Unknown roles form their own bucket under their original name.
            label = str(role or "unknown")
            assign(f"role:{label}", label, _estimate(estimator, message))
    return list(buckets.values())


def _assign_context_kind(
    assign: Callable[[str, str, int], None],
    message: dict,
    kind: str,
    estimator: ContextEstimator,
) -> None:
    total = _estimate(estimator, message)
    if kind == "rind_docs":
        content = message.get("content")
        content = content if isinstance(content, str) else ""
        has_user = RIND_DOC_USER_MARKER in content
        has_project = RIND_DOC_PROJECT_MARKER in content
        if has_user and has_project:
            user_segment = content.split(RIND_DOC_USER_MARKER, 1)[1].split(RIND_DOC_PROJECT_MARKER, 1)[0]
            user_tokens = min(total, _estimate(estimator, {"role": "system", "content": user_segment}))
            assign("rind_docs_user", "RIND.md · user", user_tokens)
            assign("rind_docs_project", "RIND.md · project", total - user_tokens)
            return
        if has_user:
            assign("rind_docs_user", "RIND.md · user", total)
            return
        if has_project:
            assign("rind_docs_project", "RIND.md · project", total)
            return
        assign("rind_docs", "RIND.md", total)
        return
    # Unknown tags form their own bucket, displayed under their original name.
    assign(f"kind:{kind}", _CONTEXT_KIND_LABELS.get(kind, kind), total)


def _assign_assistant(
    assign: Callable[[str, str, int], None],
    message: dict,
    estimator: ContextEstimator,
) -> None:
    total = _estimate(estimator, message)
    reasoning = message.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning:
        reasoning_tokens = min(
            total,
            _estimate(estimator, {"role": "assistant", "reasoning_content": reasoning}),
        )
        assign("chat_assistant", "Chat · assistant replies", total - reasoning_tokens)
        assign("reasoning", "Reasoning content", reasoning_tokens)
        return
    assign("chat_assistant", "Chat · assistant replies", total)


def _is_compaction_handoff(message: dict) -> bool:
    meta = message.get("meta")
    if isinstance(meta, dict) and meta.get("kind") == "compact_boundary":
        return True
    content = message.get("content")
    if (
        message.get("role") == "user"
        and isinstance(content, str)
        and content == COMPACT_CONTINUATION_USER_CONTENT
    ):
        return True
    reasoning = message.get("reasoning_content")
    return (
        message.get("role") == "assistant"
        and isinstance(reasoning, str)
        and reasoning == COMPACT_HANDOFF_REASONING_CONTENT
    )


def _tool_names_by_call_id(messages: list[dict]) -> dict[str, str]:
    names: dict[str, str] = {}
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            call_id = str(call.get("id") or "")
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = str(function.get("name") or "")
            if call_id and name:
                names.setdefault(call_id, name)
    return names


def _top_tool_names(messages: list[dict], tool_names: dict[str, str]) -> set[str]:
    counts: dict[str, int] = {}
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        name = tool_names.get(str(message.get("tool_call_id") or "")) or "unknown"
        counts[name] = counts.get(name, 0) + 1
    ranked = sorted(counts, key=lambda name: (-counts[name], name))
    return set(ranked[:TOOL_ROW_LIMIT])


def _estimate(estimator: ContextEstimator, message: dict) -> int:
    return max(0, int(estimator.estimate_messages([message]).estimated_input_tokens))
