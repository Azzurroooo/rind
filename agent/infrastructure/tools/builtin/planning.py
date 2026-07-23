"""The single session-local plan tool."""

from __future__ import annotations

from agent.domain import tool_error, tool_ok
from agent.domain.planning import normalize_plan
from agent.infrastructure.planning.store import write_plan


def update_plan(plan: list[dict[str, str]]) -> str:
    try:
        normalized = normalize_plan(plan)
        write_plan(normalized)
    except FileNotFoundError as exc:
        return tool_error("update_plan", str(exc), "NotFound")
    except ValueError as exc:
        return tool_error("update_plan", str(exc), "ValidationError")
    except Exception as exc:
        return tool_error("update_plan", str(exc), type(exc).__name__)
    return tool_ok("update_plan", "Plan updated")
