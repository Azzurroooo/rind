"""Plan mutation and scheduling operations."""

from __future__ import annotations

import copy
import uuid
from typing import Any

from .helpers import (
    assert_active,
    load_json_object,
    next_step_id,
    normalized_items,
    normalized_step,
    plan_meta,
)
from .model import (
    PLAN_SCHEMA_VERSION,
    STEP_MUTABLE_FIELDS,
    STEP_TRANSITIONS,
    TERMINAL_STEP_STATUS,
    CycleDetected,
    DependencyViolation,
    InvalidTransition,
    VersionConflict,
    all_deps_completed,
    assert_expected_version,
    ensure_plan_defaults,
    step_map,
    validate_graph_no_cycle,
    validate_plan_status,
    validate_step_status,
)
from .store import append_event, load_plan, now_iso, persist_plan_update, plan_paths, write_json_atomic


def create_plan(
    title: str,
    goal: str,
    steps: list[dict[str, Any]],
    expected_version: int | None = None,
    objectives: list[dict[str, Any]] | None = None,
    constraints: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    plan_file, events_file, session_id = plan_paths()
    if plan_file.exists():
        current = load_json_object(plan_file)
        if expected_version is None:
            raise ValueError("Active plan already exists.")
        assert_expected_version(current, expected_version)

    normalized = [normalized_step(item, index) for index, item in enumerate(steps)]
    if not normalized:
        raise ValueError("steps cannot be empty.")
    step_by_id = {item["step_id"]: item for item in normalized}
    if len(step_by_id) != len(normalized):
        raise ValueError("Duplicate step_id found.")
    validate_graph_no_cycle(step_by_id)
    for step in normalized:
        if step["status"] in {"in_progress", "completed"} and not all_deps_completed(step, step_by_id):
            raise DependencyViolation(f"Step {step['step_id']} violates dependency precondition.")

    now = now_iso()
    plan = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "plan_id": uuid.uuid4().hex[:12],
        "session_id": session_id,
        "title": title.strip(),
        "goal": goal.strip(),
        "status": "active",
        "objectives": normalized_items(objectives),
        "constraints": normalized_items(constraints),
        "version": 1,
        "created_at": now,
        "updated_at": now,
        "steps": normalized,
    }
    plan_file.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(plan_file, plan)
    append_event(
        events_file,
        {
            "event_id": uuid.uuid4().hex,
            "ts": now,
            "actor": "agent",
            "plan_id": plan["plan_id"],
            "type": "plan_created",
            "payload": {"title": plan["title"], "goal": plan["goal"], "steps": len(plan["steps"])},
            "from_version": 0,
            "to_version": 1,
        },
    )
    return plan


def get_plan(plan_id: str | None = None) -> dict[str, Any]:
    plan, _, _ = load_plan()
    ensure_plan_defaults(plan)
    if plan_id and plan.get("plan_id") != plan_id:
        raise FileNotFoundError(f"Plan not found: {plan_id}")
    return plan


def update_step(step_id: str, patch: dict[str, Any], expected_version: int) -> dict[str, Any]:
    plan, plan_file, events_file = load_plan()
    ensure_plan_defaults(plan)
    validate_plan_status(str(plan.get("status")))
    if plan.get("status") != "active":
        raise ValueError("Plan is not active.")
    assert_expected_version(plan, expected_version)
    if not isinstance(patch, dict):
        raise ValueError("patch must be object.")

    step_by_id = step_map(plan)
    step = step_by_id.get(step_id)
    if not step:
        raise FileNotFoundError(f"Step not found: {step_id}")

    before = copy.deepcopy(step)
    requested_status = patch.get("status")
    if requested_status is not None:
        requested_status = str(requested_status)
        validate_step_status(requested_status)
        current_status = str(step.get("status"))
        if requested_status != current_status and requested_status not in STEP_TRANSITIONS.get(current_status, set()):
            raise InvalidTransition(f"Illegal transition: {current_status} -> {requested_status}")
        if requested_status in {"in_progress", "completed"} and not all_deps_completed(step, step_by_id):
            raise DependencyViolation(f"Dependencies not completed for step: {step_id}")
        if requested_status == "blocked":
            reason = str(patch.get("blocked_reason") or step.get("blocked_reason") or "").strip()
            if not reason:
                raise ValueError("blocked status requires blocked_reason.")
        step["status"] = requested_status

    for key, value in patch.items():
        if key == "status":
            continue
        if key not in STEP_MUTABLE_FIELDS:
            raise ValueError(f"Unsupported patch field: {key}")
        step[key] = int(value) if key == "priority" else str(value or "")

    if step.get("status") != "blocked":
        step["blocked_reason"] = ""
    step["updated_at"] = now_iso()
    persist_plan_update(
        plan=plan,
        plan_file=plan_file,
        events_file=events_file,
        event_type="step_updated",
        payload={"step_id": step_id, "before": before, "after": step},
    )
    return step


def link_dependency(step_id: str, depends_on: list[str], expected_version: int) -> dict[str, Any]:
    plan, plan_file, events_file = load_plan()
    ensure_plan_defaults(plan)
    assert_expected_version(plan, expected_version)
    if not isinstance(depends_on, list):
        raise ValueError("depends_on must be array.")
    step_by_id = step_map(plan)
    step = step_by_id.get(step_id)
    if not step:
        raise FileNotFoundError(f"Step not found: {step_id}")
    updated = [str(item) for item in depends_on]
    missing = [item for item in updated if item not in step_by_id]
    if missing:
        raise DependencyViolation(f"Unknown dependency: {missing[0]}")
    step["depends_on"] = list(dict.fromkeys(updated))
    validate_graph_no_cycle(step_by_id)
    step["updated_at"] = now_iso()
    persist_plan_update(
        plan=plan,
        plan_file=plan_file,
        events_file=events_file,
        event_type="step_dependency_updated",
        payload={"step_id": step_id, "depends_on": step["depends_on"]},
    )
    return step


def reorder_steps(step_orders: list[str], expected_version: int) -> list[dict[str, Any]]:
    plan, plan_file, events_file = load_plan()
    ensure_plan_defaults(plan)
    assert_expected_version(plan, expected_version)
    if not isinstance(step_orders, list):
        raise ValueError("step_orders must be array.")
    step_by_id = step_map(plan)
    if set(step_orders) != set(step_by_id.keys()):
        raise ValueError("step_orders must include each step exactly once.")
    for index, step_id in enumerate(step_orders):
        if step_by_id[step_id].get("order") != index:
            step_by_id[step_id]["order"] = index
            step_by_id[step_id]["updated_at"] = now_iso()
    persist_plan_update(
        plan=plan,
        plan_file=plan_file,
        events_file=events_file,
        event_type="plan_reordered",
        payload={"step_orders": step_orders},
    )
    return sorted(step_by_id.values(), key=lambda item: int(item.get("order", 0)))


def close_plan(expected_version: int) -> dict[str, Any]:
    plan, plan_file, events_file = load_plan()
    ensure_plan_defaults(plan)
    assert_expected_version(plan, expected_version)
    step_by_id = step_map(plan)
    unfinished = [step_id for step_id, step in step_by_id.items() if step.get("status") not in TERMINAL_STEP_STATUS]
    if unfinished:
        raise DependencyViolation(f"Cannot close plan with unfinished steps: {unfinished}")
    plan["status"] = "completed"
    persist_plan_update(
        plan=plan,
        plan_file=plan_file,
        events_file=events_file,
        event_type="plan_closed",
        payload={"completed_steps": len(step_by_id)},
    )
    return plan


def add_step(
    title: str,
    description: str = "",
    step_id: str | None = None,
    depends_on: list[str] | None = None,
    priority: int = 0,
    owner: str = "",
    acceptance: str = "",
    expected_version: int = 0,
) -> dict[str, Any]:
    plan, plan_file, events_file = load_plan()
    ensure_plan_defaults(plan)
    assert_active(plan)
    assert_expected_version(plan, expected_version)
    title = str(title or "").strip()
    if not title:
        raise ValueError("title cannot be empty.")
    step_by_id = step_map(plan)
    deps = [str(item) for item in (depends_on or [])]
    missing = [item for item in deps if item not in step_by_id]
    if missing:
        raise DependencyViolation(f"Unknown dependency: {missing[0]}")
    new_step_id = str(step_id or "").strip() or next_step_id(step_by_id)
    if new_step_id in step_by_id:
        raise ValueError(f"Duplicate step_id found: {new_step_id}")
    order = max([int(step.get("order", index)) for index, step in enumerate(plan.get("steps", []))], default=-1) + 1
    now = now_iso()
    step = {
        "step_id": new_step_id,
        "title": title,
        "description": str(description or ""),
        "status": "pending",
        "depends_on": deps,
        "priority": int(priority),
        "owner": str(owner or ""),
        "acceptance": str(acceptance or ""),
        "note": "",
        "blocked_reason": "",
        "created_at": now,
        "updated_at": now,
        "order": order,
    }
    plan.setdefault("steps", []).append(step)
    validate_graph_no_cycle(step_map(plan))
    persist_plan_update(
        plan=plan,
        plan_file=plan_file,
        events_file=events_file,
        event_type="step_added",
        payload={"step_id": new_step_id, "step": step},
    )
    return step


def update_meta(
    expected_version: int,
    goal: str | None = None,
    objectives: list[dict[str, Any]] | None = None,
    constraints: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    plan, plan_file, events_file = load_plan()
    ensure_plan_defaults(plan)
    assert_active(plan)
    assert_expected_version(plan, expected_version)
    updates: dict[str, Any] = {}

    if goal is not None:
        plan["goal"] = str(goal).strip()
        updates["goal"] = plan["goal"]
    if objectives is not None:
        plan["objectives"] = normalized_items(objectives)
        updates["objectives"] = plan["objectives"]
    if constraints is not None:
        plan["constraints"] = normalized_items(constraints)
        updates["constraints"] = plan["constraints"]

    if not updates:
        raise ValueError("At least one metadata field must be provided.")

    persist_plan_update(
        plan=plan,
        plan_file=plan_file,
        events_file=events_file,
        event_type="plan_meta_updated",
        payload=updates,
    )
    return plan_meta(plan)
