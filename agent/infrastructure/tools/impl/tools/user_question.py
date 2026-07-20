"""Tool declaration for runtime-mediated user questions."""

from __future__ import annotations

from agent.domain import tool_error


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
