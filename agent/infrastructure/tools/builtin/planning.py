"""The single session-local plan tool."""

from __future__ import annotations

from agent.domain import tool_error, tool_ok
from agent.domain.planning import normalize_plan
from agent.infrastructure.planning.store import write_plan
from agent.infrastructure.tools.spec import ToolSpec


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


TOOL_SPECS = (
    ToolSpec(
        name="update_plan",
        handler=update_plan,
        description=(
            "Maintain a lightweight plan for a multi-step task. Every call must submit the complete list; "
            "array order is both the display and the execution priority. Stores control state only, not "
            "factual summaries. Status must be pending, in_progress, completed, or cancelled, with at most "
            "one in_progress; mark a step completed only after the work is done and verified."
        ),
        param_descriptions={
            "plan": {
                "description": "The complete plan; pass an empty array to clear the current plan.",
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "step": {"type": "string", "minLength": 1},
                        "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]},
                    },
                    "required": ["step", "status"],
                    "additionalProperties": False,
                },
            }
        },
    ),
)
