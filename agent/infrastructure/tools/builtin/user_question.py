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
        description="Ask the user a question that must be confirmed by them. Use only when a preference, scope decision, blocking choice, or information genuinely absent from the environment needs a human answer; do not ask about things tools can discover.",
        param_descriptions={
            "question": "The single, clearly stated question to ask the user",
            "options": {
                "description": "Optional structured answer list; the first item's label must end with \" (Recommended)\" and no other item may use that suffix. The user can also type free text.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Short answer label"},
                        "description": {"type": "string", "description": "Brief explanation of the answer"},
                    },
                    "required": ["label", "description"],
                    "additionalProperties": False,
                },
            },
        },
    ),
)
