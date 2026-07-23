"""Validation for the session-local plan list."""

from __future__ import annotations

from typing import Any

PLAN_SCHEMA_VERSION = "2.0"
PLAN_STEP_STATUSES = ("pending", "in_progress", "completed", "cancelled")
_PLAN_STEP_STATUS_SET = frozenset(PLAN_STEP_STATUSES)


def normalize_plan(plan: Any) -> list[dict[str, str]]:
    """Validate and normalize the complete plan submitted by the model."""
    if not isinstance(plan, list):
        raise ValueError("plan must be an array.")

    normalized: list[dict[str, str]] = []
    in_progress_count = 0
    for index, item in enumerate(plan):
        if not isinstance(item, dict):
            raise ValueError(f"Plan item at index {index} must be an object.")
        if set(item) != {"step", "status"}:
            raise ValueError(f"Plan item at index {index} must contain only step and status.")

        step = item.get("step")
        status = item.get("status")
        if not isinstance(step, str) or not step.strip():
            raise ValueError(f"Plan item at index {index} requires a non-empty step.")
        if not isinstance(status, str) or status not in _PLAN_STEP_STATUS_SET:
            raise ValueError(
                f"Plan item at index {index} has invalid status; "
                f"expected one of {', '.join(PLAN_STEP_STATUSES)}."
            )
        if status == "in_progress":
            in_progress_count += 1
            if in_progress_count > 1:
                raise ValueError("Plan may contain at most one in_progress item.")

        normalized.append({"step": step.strip(), "status": status})

    return normalized
