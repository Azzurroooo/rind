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

    previous = Config.DEFAULT_MODEL
    Config.set_model(clean)
    active = await _update_active_model(runtime, session, clean)
    return {
        "model": Config.DEFAULT_MODEL,
        "previous_default": previous,
        "new_default": Config.DEFAULT_MODEL,
        "runtime": active["runtime"],
        "session": active["session"],
        "active_updated": active["runtime"] or active["session"],
    }


async def _update_active_model(runtime: Any, session: Any, model: str) -> dict[str, bool]:
    runtime_updated = False
    session_updated = False

    set_model = getattr(runtime, "set_model", None)
    if callable(set_model):
        result = set_model(model)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, dict):
            runtime_updated = bool(result.get("runtime"))
            session_updated = bool(result.get("session"))
        elif isinstance(result, bool):
            runtime_updated = result
        else:
            runtime_updated = True

    update_model = getattr(session, "update_model", None)
    if callable(update_model) and not session_updated:
        result = update_model(model)
        if inspect.isawaitable(result):
            await result
        session_updated = True
    return {"runtime": runtime_updated, "session": session_updated}
