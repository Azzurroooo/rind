"""Tool declaration for runtime-mediated user questions."""

from __future__ import annotations

from agent.domain import tool_error
from agent.infrastructure.tools.spec import ToolSpec


def ask_user_question(
    question: str,
    options: list[dict[str, str]] | None = None,
) -> str:
    """Ask the user a direct question through a runtime responder."""
    return tool_error(
        "ask_user_question",
        "No user-question responder is available in this execution environment.",
        "UserQuestionUnsupported",
    )


TOOL_SPECS = (
    ToolSpec(
        name="ask_user_question",
        handler=ask_user_question,
        description="向用户提出一个必须由用户确认的问题。仅当偏好、范围、阻塞决策或无法从环境发现的信息确实需要用户回答时使用；不要询问可通过工具探索得到的问题。",
        param_descriptions={
            "question": "要向用户提出的单个明确问题",
            "options": {
                "description": "可选结构化答案列表；首项的 label 必须以 \" (Recommended)\" 结尾，其他选项不得使用该后缀。用户也可输入自由文本。",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "简短的答案标签"},
                        "description": {"type": "string", "description": "解释该答案的简短说明"},
                    },
                    "required": ["label", "description"],
                    "additionalProperties": False,
                },
            },
        },
    ),
)
