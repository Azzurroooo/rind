"""Validation, event construction, and execution for the ask_user_question tool."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from agent.application.ports.session_store import SessionStore
from agent.domain import (
    ParsedToolCall,
    ToolEventStatus,
    tool_cancelled,
    tool_error,
    tool_ok,
)
from agent.domain.cancellation import CancellationToken
from agent.domain.events import UserQuestionRequestedEvent, event_meta

UserQuestionResponder = Callable[[UserQuestionRequestedEvent], str | Awaitable[str]]


def build_user_question_event(
    *,
    session: SessionStore,
    turn_id: str,
    call: ParsedToolCall,
    parsed_args: dict,
) -> UserQuestionRequestedEvent:
    question = _clean_required_text(parsed_args.get("question"))
    if not question:
        raise ValueError("ask_user_question requires a non-empty question string.")
    if "recommended" in parsed_args:
        raise ValueError("ask_user_question no longer accepts a top-level recommended field.")
    options = _clean_user_question_options(parsed_args.get("options"))
    return UserQuestionRequestedEvent(
        **event_meta(session, turn_id),
        tool_call_id=call.call_id,
        question=question,
        options=options,
    )


async def run_user_question(
    responder: UserQuestionResponder | None,
    event: UserQuestionRequestedEvent,
    cancellation_token: CancellationToken | None,
) -> tuple[ToolEventStatus, str, str]:
    if responder is None:
        return (
            "unavailable",
            tool_error(
                "ask_user_question",
                "No user-question responder is available in this execution environment.",
                "UserQuestionUnsupported",
            ),
            "UserQuestionUnsupported",
        )
    try:
        answer_value = responder(event)
        if isinstance(answer_value, Awaitable):
            answer_value = await answer_value
    except (KeyboardInterrupt, EOFError) as exc:
        return (
            "cancelled",
            tool_error(
                "ask_user_question",
                "User question input was interrupted.",
                type(exc).__name__,
            ),
            type(exc).__name__,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        return (
            "failed",
            tool_error("ask_user_question", str(exc), type(exc).__name__),
            type(exc).__name__,
        )

    # Interrupting the turn releases the question; the user did not answer it.
    if cancellation_token and cancellation_token.is_cancelled:
        return (
            "cancelled",
            tool_cancelled("ask_user_question", cancellation_token.reason),
            "Cancelled",
        )
    answer = str(answer_value or "").strip()
    if not answer:
        return (
            "failed",
            tool_error(
                "ask_user_question",
                "User provided an empty answer.",
                "UserQuestionEmptyAnswer",
            ),
            "UserQuestionEmptyAnswer",
        )
    return (
        "completed",
        tool_ok("ask_user_question", {"answer": answer}),
        "",
    )


def _clean_required_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()


def _clean_user_question_options(value: Any) -> list[dict[str, str]] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not value:
        raise ValueError("ask_user_question options must be a non-empty array of option objects.")
    cleaned: list[dict[str, str]] = []
    labels: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError("Each ask_user_question option must be an object.")
        unknown = set(item) - {"label", "description"}
        if unknown:
            raise ValueError(f"ask_user_question options contain unsupported fields: {sorted(unknown)!r}.")
        label = item.get("label")
        description = item.get("description")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("Each ask_user_question option requires a non-empty label.")
        if not isinstance(description, str) or not description.strip():
            raise ValueError("Each ask_user_question option requires a non-empty description.")
        label = label.strip()
        if label in labels:
            raise ValueError(f"ask_user_question option labels must be unique: {label!r}.")
        labels.add(label)
        has_recommended_suffix = label.endswith(" (Recommended)")
        if index == 0 and not has_recommended_suffix:
            raise ValueError('The first ask_user_question option label must end with " (Recommended)".')
        if index > 0 and has_recommended_suffix:
            raise ValueError('Only the first ask_user_question option may end with " (Recommended)".')
        cleaned.append({"label": label, "description": description.strip()})
    return cleaned
