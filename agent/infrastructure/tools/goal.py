"""Goal tool bound to the active session store."""

from __future__ import annotations

from typing import Awaitable, Callable

from agent.domain import tool_error, tool_ok
from agent.domain.goal import GOAL_TERMINAL_STATUSES, normalize_goal_status
from agent.infrastructure.tools.spec import ToolSpec


def create_goal_tool_spec(
    set_goal_status: Callable[[str], Awaitable[dict[str, str]]],
) -> ToolSpec:
    async def update_goal(status: str) -> str:
        try:
            normalized = normalize_goal_status(status)
            if normalized not in GOAL_TERMINAL_STATUSES:
                raise ValueError(
                    "update_goal can only set complete or blocked."
                )
            goal = await set_goal_status(normalized)
            return tool_ok("update_goal", goal)
        except ValueError as exc:
            return tool_error("update_goal", str(exc), "ValidationError")
        except Exception as exc:
            return tool_error("update_goal", str(exc), type(exc).__name__)

    return ToolSpec(
        name="update_goal",
        handler=update_goal,
        description=(
            "Finish the active persistent goal only after verifying the requested end state, "
            "or mark it blocked when meaningful progress is impossible."
        ),
        param_descriptions={
            "status": {
                "description": "The goal terminal status.",
                "enum": ["complete", "blocked"],
            }
        },
    )
