"""Render the session-local plan for CLI and compact handoffs."""

from __future__ import annotations

from agent.domain.planning import PLAN_STEP_STATUSES

DEFAULT_SUMMARY_CHAR_LIMIT = 2200
TRUNCATION_HINT = "\n...(plan summary truncated due to context budget)..."


def render_plan_summary(plan: list[dict[str, str]], char_limit: int = DEFAULT_SUMMARY_CHAR_LIMIT) -> str:
    if not plan:
        return ""

    counts = {status: 0 for status in PLAN_STEP_STATUSES}
    lines = ["Active plan:"]
    for item in plan:
        status = item["status"]
        counts[status] += 1
        lines.append(f"- [{status}] {item['step']}")
    lines.append(
        "- Progress: "
        + ", ".join(f"{status}={counts[status]}" for status in ("completed", "in_progress", "pending", "cancelled"))
    )
    return _truncate("\n".join(lines), char_limit)


def build_plan_snapshot(char_limit: int = 1800) -> str:
    try:
        from .store import load_plan_if_exists

        plan = load_plan_if_exists()
    except Exception:
        return ""
    return render_plan_summary(plan or [], char_limit=max(0, int(char_limit)))


def _truncate(text: str, char_limit: int) -> str:
    limit = max(0, int(char_limit))
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit <= len(TRUNCATION_HINT):
        return TRUNCATION_HINT[:limit]
    return text[: limit - len(TRUNCATION_HINT)].rstrip() + TRUNCATION_HINT
