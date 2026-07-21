"""Render deterministic plan control state for model context."""

from __future__ import annotations

import json
from typing import Any

TERMINAL_STEP_STATUS = {"completed", "canceled"}
DEFAULT_SUMMARY_CHAR_LIMIT = 2200
TRUNCATION_HINT = "\n...(plan summary truncated due to context budget)..."


def step_counts(plan: dict[str, Any]) -> dict[str, int]:
    counts = {status: 0 for status in ("pending", "in_progress", "blocked", "completed", "canceled")}
    for step in _steps(plan):
        status = str(step.get("status") or "pending")
        counts[status] = counts.get(status, 0) + 1
    return counts


def unfinished_steps(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [step for step in _steps(plan) if step.get("status") not in TERMINAL_STEP_STATUS]


def is_terminal_open_plan(plan: dict[str, Any]) -> bool:
    return plan.get("status") == "active" and bool(_steps(plan)) and not unfinished_steps(plan)


def render_compact_plan_summary(plan: dict[str, Any], char_limit: int = DEFAULT_SUMMARY_CHAR_LIMIT) -> str:
    if plan.get("status") != "active":
        return ""

    if is_terminal_open_plan(plan):
        text = "\n".join(
            [
                "Active plan summary:",
                f"- Plan: {_plan_label(plan)}",
                "- State: open plan has no unfinished steps.",
                "- Next: if the goal is satisfied, call plan_close; otherwise call plan_add_step for the next iteration.",
            ]
        )
        return _truncate(text, char_limit)

    counts = step_counts(plan)
    focus = _focus_step(plan)
    lines = [
        "Active plan summary:",
        f"- Plan: {_plan_label(plan)}",
    ]
    goal = str(plan.get("goal") or "").strip()
    if goal:
        lines.append(f"- Goal: {goal}")
    objectives = _format_targets(plan.get("objectives"), limit=3)
    if objectives:
        lines.append(f"- Objectives: {objectives}")
    constraints = _format_targets(plan.get("constraints"), limit=3)
    if constraints:
        lines.append(f"- Constraints: {constraints}")
    lines.append(
        "- Progress: "
        + ", ".join(f"{key}={counts.get(key, 0)}" for key in ("completed", "in_progress", "blocked", "pending", "canceled"))
    )
    if focus:
        lines.append(f"- Current focus: {focus.get('step_id')} - {focus.get('title')}")
        acceptance = str(focus.get("acceptance") or "").strip()
        if acceptance:
            lines.append(f"- Acceptance: {acceptance}")
        note = str(focus.get("note") or "").strip()
        if note:
            lines.append(f"- Focus note: {note}")
    return _truncate("\n".join(lines), char_limit)


def plan_state(plan: dict[str, Any] | None) -> str:
    if not plan:
        return "none"
    status = plan.get("status")
    if status in {"completed", "canceled"}:
        return "closed"
    if status == "active":
        return "terminal_open" if is_terminal_open_plan(plan) else "open"
    return "error"


def _steps(plan: dict[str, Any]) -> list[dict[str, Any]]:
    steps = plan.get("steps", [])
    return [step for step in steps if isinstance(step, dict)] if isinstance(steps, list) else []


def _plan_label(plan: dict[str, Any]) -> str:
    title = str(plan.get("title") or plan.get("plan_id") or "untitled").strip()
    version = plan.get("version")
    return f"{title} (version {version})" if version is not None else title


def _focus_step(plan: dict[str, Any]) -> dict[str, Any] | None:
    steps = sorted(_steps(plan), key=lambda item: int(item.get("order", 0)))
    in_progress = [step for step in steps if step.get("status") == "in_progress"]
    if in_progress:
        return in_progress[0]
    step_by_id = {step.get("step_id"): step for step in steps if step.get("step_id")}
    ready = [step for step in steps if step.get("status") == "pending" and _deps_completed(step, step_by_id)]
    if ready:
        return sorted(ready, key=lambda item: (-int(item.get("priority", 0)), int(item.get("order", 0))))[0]
    blocked = [step for step in steps if step.get("status") == "blocked"]
    return blocked[0] if blocked else None


def _deps_completed(step: dict[str, Any], step_by_id: dict[Any, dict[str, Any]]) -> bool:
    deps = step.get("depends_on") or []
    if not isinstance(deps, list):
        return False
    for dep_id in deps:
        dep = step_by_id.get(dep_id)
        if not dep or dep.get("status") != "completed":
            return False
    return True


def _format_targets(value: Any, limit: int) -> str:
    if not isinstance(value, list):
        return ""
    rendered: list[str] = []
    for item in value[:limit]:
        if not isinstance(item, dict):
            continue
        metric = str(item.get("metric") or item.get("name") or "").strip()
        operator = str(item.get("operator") or "").strip()
        target = item.get("target")
        unit = str(item.get("unit") or "").strip()
        if not metric:
            rendered.append(_compact_json(item))
            continue
        text = f"{metric} {operator} {target}".strip()
        if unit:
            text += f" {unit}"
        rendered.append(text)
    return "; ".join(rendered)


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _truncate(text: str, char_limit: int) -> str:
    limit = max(0, int(char_limit))
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit <= len(TRUNCATION_HINT):
        return TRUNCATION_HINT[:limit]
    return text[: limit - len(TRUNCATION_HINT)].rstrip() + TRUNCATION_HINT
