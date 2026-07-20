"""Small helper functions for plan operations."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .model import validate_step_status
from .store import now_iso


def normalized_step(step: dict[str, Any], index: int) -> dict[str, Any]:
    if not isinstance(step, dict):
        raise ValueError(f"Step at index {index} must be object.")
    title = str(step.get("title", "")).strip()
    if not title:
        raise ValueError(f"Step at index {index} missing title.")
    step_id = str(step.get("step_id") or f"step_{index + 1}")
    depends_on = step.get("depends_on") or []
    if not isinstance(depends_on, list):
        raise ValueError(f"Step {step_id} depends_on must be a list.")
    status = str(step.get("status") or "pending")
    validate_step_status(status)
    now = now_iso()
    return {
        "step_id": step_id,
        "title": title,
        "description": str(step.get("description") or ""),
        "status": status,
        "depends_on": [str(item) for item in depends_on],
        "priority": int(step.get("priority", 0)),
        "owner": str(step.get("owner") or ""),
        "acceptance": str(step.get("acceptance") or ""),
        "note": str(step.get("note") or ""),
        "blocked_reason": str(step.get("blocked_reason") or ""),
        "created_at": now,
        "updated_at": now,
        "order": index,
    }


def dependency_depth(step_id: str, steps: dict[str, dict[str, Any]], memo: dict[str, int]) -> int:
    if step_id in memo:
        return memo[step_id]
    deps = steps[step_id].get("depends_on") or []
    if not deps:
        memo[step_id] = 0
        return 0
    value = 1 + max(dependency_depth(dep, steps, memo) for dep in deps if dep in steps)
    memo[step_id] = value
    return value


def assert_active(plan: dict[str, Any]) -> None:
    if plan.get("status") != "active":
        raise ValueError("Plan is not active.")


def next_step_id(step_by_id: dict[str, dict[str, Any]]) -> str:
    index = len(step_by_id) + 1
    while f"step_{index}" in step_by_id:
        index += 1
    return f"step_{index}"


def normalized_items(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if items is None:
        return []
    if not isinstance(items, list):
        raise ValueError("objectives/constraints must be arrays.")
    normalized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("objective/constraint items must be objects.")
        normalized.append(dict(item))
    return normalized


def plan_meta(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "plan_id": plan.get("plan_id"),
        "title": plan.get("title"),
        "goal": plan.get("goal"),
        "status": plan.get("status"),
        "version": plan.get("version"),
        "objectives": plan.get("objectives", []),
        "constraints": plan.get("constraints", []),
    }


def load_json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Corrupted plan file: expected object.")
    return value
