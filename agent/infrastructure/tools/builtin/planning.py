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
            "维护多步骤任务的轻量计划。每次调用必须提交完整列表，数组顺序就是展示和执行优先顺序；"
            "只保存控制状态，不记录事实总结。状态只能是 pending、in_progress、completed 或 cancelled，"
            "最多一个 in_progress；完成工作并验证后再标记 completed。"
        ),
        param_descriptions={
            "plan": {
                "description": "完整计划列表；传入空数组可清空当前计划。",
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
