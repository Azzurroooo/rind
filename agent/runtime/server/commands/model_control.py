"""Shared model selection helpers for CLI command surfaces."""

from __future__ import annotations

from typing import Any

from agent.infrastructure.config.settings_loader import DEFAULT_MODEL, load_settings


def normalize_model_name(value: object) -> str | None:
    text = str(value or "").strip()
    if not text or any(character.isspace() for character in text):
        return None
    if len(text) > 128:
        return None
    return text


def _default_model(session: Any) -> str:
    workspace_root = getattr(session, "workspace_root", None)
    try:
        return load_settings(workspace_root).model
    except (OSError, ValueError):
        return DEFAULT_MODEL
