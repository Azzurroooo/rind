"""Tool declaration for runtime-mediated user questions."""

from __future__ import annotations

from agent.domain import tool_error
from agent.infrastructure.tools.spec import ToolSpec


def ask_user_question(
    question: str,
    options: list[str] | None = None,
    recommended: str | None = None,
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
            "options": "可选答案列表，字符串数组；用户也可输入自由文本。",
            "recommended": "可选推荐答案，应与 options 中的一项文本一致或为空。",
        },
    ),
)
