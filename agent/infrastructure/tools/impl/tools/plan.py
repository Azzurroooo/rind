"""Plan management tools with DAG dependencies and optimistic locking."""

from __future__ import annotations

from typing import Any

from agent.domain import tool_error, tool_ok
from agent.infrastructure.plans import operations as ops
from agent.infrastructure.plans import scheduler


def plan_create(
    title: str,
    goal: str,
    steps: list[dict[str, Any]],
    expected_version: int | None = None,
    objectives: list[dict[str, Any]] | None = None,
    constraints: list[dict[str, Any]] | None = None,
) -> str:
    try:
        plan = ops.create_plan(title, goal, steps, expected_version, objectives, constraints)
        return tool_ok("plan_create", plan, meta={"plan_id": plan["plan_id"], "version": plan["version"]})
    except Exception as exc:
        return _tool_exception("plan_create", exc)


def plan_get(plan_id: str | None = None) -> str:
    try:
        plan = ops.get_plan(plan_id)
        return tool_ok("plan_get", plan, meta={"plan_id": plan.get("plan_id"), "version": plan.get("version")})
    except Exception as exc:
        return _tool_exception("plan_get", exc)


def plan_update_step(step_id: str, patch: dict[str, Any], expected_version: int) -> str:
    try:
        step = ops.update_step(step_id, patch, expected_version)
        plan = ops.get_plan()
        return tool_ok(
            "plan_update_step",
            {
                "updated_step": scheduler.updated_step_snapshot(step),
                "plan_snapshot": scheduler.plan_snapshot(plan),
            },
            meta={"plan_id": plan.get("plan_id"), "version": plan.get("version"), "step_id": step_id},
        )
    except Exception as exc:
        return _tool_exception("plan_update_step", exc)


def plan_link_dependency(step_id: str, depends_on: list[str], expected_version: int) -> str:
    try:
        step = ops.link_dependency(step_id, depends_on, expected_version)
        return tool_ok(
            "plan_link_dependency",
            step,
            meta={"plan_id": _plan_id(), "version": _current_version(), "step_id": step_id},
        )
    except Exception as exc:
        return _tool_exception("plan_link_dependency", exc)


def plan_reorder(step_orders: list[str], expected_version: int) -> str:
    try:
        ordered = ops.reorder_steps(step_orders, expected_version)
        return tool_ok("plan_reorder", ordered, meta={"plan_id": _plan_id(), "version": _current_version()})
    except Exception as exc:
        return _tool_exception("plan_reorder", exc)


def plan_next(mode: str, expected_version: int | None = None) -> str:
    try:
        data, meta = scheduler.next_steps(mode, expected_version)
        return tool_ok("plan_next", data, meta=meta)
    except Exception as exc:
        return _tool_exception("plan_next", exc)


def plan_close(expected_version: int) -> str:
    try:
        plan = ops.close_plan(expected_version)
        data = {
            "plan_id": plan.get("plan_id"),
            "status": plan.get("status"),
            "version": plan.get("version"),
            "completed_steps": len(plan.get("steps") or []),
        }
        return tool_ok("plan_close", data, meta={"plan_id": plan.get("plan_id"), "version": plan.get("version")})
    except Exception as exc:
        return _tool_exception("plan_close", exc)


def plan_add_step(
    title: str,
    expected_version: int,
    description: str = "",
    step_id: str | None = None,
    depends_on: list[str] | None = None,
    priority: int = 0,
    owner: str = "",
    acceptance: str = "",
) -> str:
    try:
        step = ops.add_step(title, description, step_id, depends_on, priority, owner, acceptance, expected_version)
        return tool_ok(
            "plan_add_step",
            step,
            meta={"plan_id": _plan_id(), "version": _current_version(), "step_id": step.get("step_id")},
        )
    except Exception as exc:
        return _tool_exception("plan_add_step", exc)


def plan_update_meta(
    expected_version: int,
    goal: str | None = None,
    objectives: list[dict[str, Any]] | None = None,
    constraints: list[dict[str, Any]] | None = None,
) -> str:
    try:
        meta_data = ops.update_meta(expected_version, goal, objectives, constraints)
        return tool_ok(
            "plan_update_meta",
            meta_data,
            meta={"plan_id": meta_data.get("plan_id"), "version": meta_data.get("version")},
        )
    except Exception as exc:
        return _tool_exception("plan_update_meta", exc)


def _current_version() -> int | None:
    try:
        return ops.get_plan().get("version")
    except Exception:
        return None


def _plan_id() -> str | None:
    try:
        value = ops.get_plan().get("plan_id")
        return str(value) if value else None
    except Exception:
        return None


def _tool_exception(tool_name: str, exc: Exception) -> str:
    if isinstance(exc, FileNotFoundError):
        return tool_error(tool_name, str(exc), "NotFound")
    if isinstance(exc, ops.VersionConflict):
        return tool_error(tool_name, str(exc), "VersionConflict")
    if isinstance(exc, ops.CycleDetected):
        return tool_error(tool_name, str(exc), "CycleDetected")
    if isinstance(exc, ops.DependencyViolation):
        return tool_error(tool_name, str(exc), "DependencyViolation")
    if isinstance(exc, ops.InvalidTransition):
        return tool_error(tool_name, str(exc), "InvalidTransition")
    if isinstance(exc, ValueError):
        return tool_error(tool_name, str(exc), "ValidationError")
    return tool_error(tool_name, str(exc), type(exc).__name__)
