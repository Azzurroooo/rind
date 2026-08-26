"""Shared model selection helpers for CLI command surfaces."""

from __future__ import annotations

import inspect
from typing import Any

from agent.infrastructure.config import Config


def normalize_model_name(value: object) -> str | None:
    text = str(value or "").strip()
    if not text or any(character.isspace() for character in text):
        return None
    if len(text) > 128:
        return None
    return text


async def set_active_model(runtime: Any, session: Any, model: str) -> dict[str, object]:
    clean = normalize_model_name(model)
    if clean is None:
        raise ValueError("Model name is required.")

    default_model = str(Config.DEFAULT_MODEL or "").strip()
    active = await _update_active_model(runtime, session, clean)
    return {
        "model": clean,
        "session_model": clean,
        "default_model": default_model,
        "previous_default": default_model,
        "new_default": default_model,
        "default_updated": False,
        "runtime": active["runtime"],
        "session": active["session"],
        "active_updated": active["runtime"] or active["session"],
    }


async def set_active_reasoning_effort(runtime: Any, session: Any, effort: str) -> dict[str, object]:
    active = await _update_active(
        runtime, session, effort, setter_name="set_reasoning_effort", updater_name="update_reasoning_effort",
    )
    return {
        "reasoning_effort": str(effort or "").strip().lower(),
        "runtime": active["runtime"],
        "session": active["session"],
        "active_updated": active["runtime"] or active["session"],
    }


async def _update_active_model(runtime: Any, session: Any, model: str) -> dict[str, bool]:
    return await _update_active(runtime, session, model, setter_name="set_model", updater_name="update_model")


async def _update_active(runtime: Any, session: Any, value: str, *, setter_name: str, updater_name: str) -> dict[str, bool]:
    runtime_updated = False
    session_updated = False

    set_value = getattr(runtime, setter_name, None)
    if callable(set_value):
        result = set_value(value)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, dict):
            runtime_updated = bool(result.get("runtime"))
            session_updated = bool(result.get("session"))
        elif isinstance(result, bool):
            runtime_updated = result
        else:
            runtime_updated = True

    update_value = getattr(session, updater_name, None)
    if callable(update_value) and not session_updated:
        result = update_value(value)
        if inspect.isawaitable(result):
            await result
        session_updated = True
    return {"runtime": runtime_updated, "session": session_updated}
