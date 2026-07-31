"""Validation for the session-local persistent goal."""

from __future__ import annotations

from typing import Any


GOAL_STATUSES = ("active", "paused", "blocked", "complete")
GOAL_TERMINAL_STATUSES = ("blocked", "complete")
MAX_GOAL_OBJECTIVE_CHARS = 4_000


def normalize_goal_objective(value: Any) -> str:
    objective = str(value or "").strip()
    if not objective:
        raise ValueError("Goal objective must not be empty.")
    if len(objective) > MAX_GOAL_OBJECTIVE_CHARS:
        raise ValueError(
            f"Goal objective must be at most {MAX_GOAL_OBJECTIVE_CHARS} characters."
        )
    return objective


def normalize_goal_status(value: Any) -> str:
    status = str(value or "").strip().lower()
    if status not in GOAL_STATUSES:
        raise ValueError(
            f"Goal status must be one of {', '.join(GOAL_STATUSES)}."
        )
    return status


def normalize_goal(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"objective", "status"}:
        raise ValueError("Corrupted goal: expected objective and status.")
    return {
        "objective": normalize_goal_objective(value["objective"]),
        "status": normalize_goal_status(value["status"]),
    }
