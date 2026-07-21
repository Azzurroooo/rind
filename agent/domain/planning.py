"""Shared plan constants, exceptions, and validation helpers."""

from __future__ import annotations

from typing import Any

PLAN_SCHEMA_VERSION = "1.1"
PLAN_STATUS = {"active", "completed", "canceled"}
STEP_STATUS = {"pending", "in_progress", "blocked", "completed", "canceled"}
TERMINAL_STEP_STATUS = {"completed", "canceled"}
STEP_MUTABLE_FIELDS = {"title", "description", "priority", "owner", "acceptance", "note", "blocked_reason"}

STEP_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"in_progress", "blocked", "canceled"},
    "in_progress": {"completed", "blocked", "pending", "canceled"},
    "blocked": {"pending", "in_progress", "canceled"},
    "completed": set(),
    "canceled": set(),
}


def ensure_plan_defaults(plan: dict[str, Any]) -> dict[str, Any]:
    plan.setdefault("schema_version", PLAN_SCHEMA_VERSION)
    plan.setdefault("objectives", [])
    plan.setdefault("constraints", [])
    if not isinstance(plan["objectives"], list):
        plan["objectives"] = []
    if not isinstance(plan["constraints"], list):
        plan["constraints"] = []
    return plan


def step_map(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    steps = plan.get("steps", [])
    if not isinstance(steps, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for step in steps:
        if isinstance(step, dict) and isinstance(step.get("step_id"), str):
            out[step["step_id"]] = step
    return out


def assert_expected_version(plan: dict[str, Any], expected_version: int) -> None:
    current = int(plan.get("version", 0))
    if current != expected_version:
        raise VersionConflict(f"VersionConflict: expected {expected_version}, current {current}")


def validate_plan_status(status: str) -> None:
    if status not in PLAN_STATUS:
        raise ValueError(f"Invalid plan status: {status}")


def validate_step_status(status: str) -> None:
    if status not in STEP_STATUS:
        raise ValueError(f"Invalid step status: {status}")


def all_deps_completed(step: dict[str, Any], step_by_id: dict[str, dict[str, Any]]) -> bool:
    deps = step.get("depends_on") or []
    if not isinstance(deps, list):
        return False
    for dep_id in deps:
        dep = step_by_id.get(dep_id)
        if not dep or dep.get("status") != "completed":
            return False
    return True


def validate_graph_no_cycle(step_by_id: dict[str, dict[str, Any]]) -> None:
    edges: dict[str, list[str]] = {}
    for step_id, step in step_by_id.items():
        deps = step.get("depends_on") or []
        if not isinstance(deps, list):
            raise ValueError(f"Step {step_id} depends_on must be a list.")
        for dep_id in deps:
            if dep_id not in step_by_id:
                raise DependencyViolation(f"Step {step_id} depends on unknown step: {dep_id}")
            if dep_id == step_id:
                raise ValueError(f"Step {step_id} cannot depend on itself.")
        edges[step_id] = [dep for dep in deps if isinstance(dep, str)]

    visiting: set[str] = set()
    visited: set[str] = set()

    def dfs(node: str) -> None:
        if node in visited:
            return
        if node in visiting:
            raise CycleDetected("CycleDetected: dependency cycle found.")
        visiting.add(node)
        for child in edges.get(node, []):
            dfs(child)
        visiting.remove(node)
        visited.add(node)

    for key in edges:
        dfs(key)


class VersionConflict(RuntimeError):
    pass


class DependencyViolation(ValueError):
    pass


class InvalidTransition(ValueError):
    pass


class CycleDetected(ValueError):
    pass
