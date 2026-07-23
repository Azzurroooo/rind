"""Session-local plan file storage."""

from __future__ import annotations

import json
import os
import uuid
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from agent.domain.planning import PLAN_SCHEMA_VERSION, normalize_plan
from agent.infrastructure.paths import resolve_session_base as resolve_checked_session_base
from agent.infrastructure.paths import validate_session_id

_ACTIVE_SESSION_ROOT: ContextVar[str | None] = ContextVar("rind_plan_session_root", default=None)
_ACTIVE_SESSION_ID: ContextVar[str | None] = ContextVar("rind_plan_session_id", default=None)


def set_active_session_context(session_root: str, session_id: str) -> None:
    root = str(session_root or "").strip()
    sid = str(session_id or "").strip()
    if not root or not sid:
        return
    _ACTIVE_SESSION_ROOT.set(root)
    _ACTIVE_SESSION_ID.set(validate_session_id(sid))


def resolve_session_base() -> tuple[Path, str]:
    context_root = _ACTIVE_SESSION_ROOT.get()
    context_id = _ACTIVE_SESSION_ID.get()
    if context_root and context_id:
        base = resolve_checked_session_base(context_root, context_id)
        if base.is_dir():
            return base, context_id

    env_root = os.getenv("AGENT_SESSION_ROOT")
    env_id = os.getenv("AGENT_SESSION_ID")
    if env_root and env_id:
        env_id = validate_session_id(env_id)
        base = resolve_checked_session_base(env_root, env_id)
        if base.is_dir():
            return base, env_id
    raise FileNotFoundError(
        "No active session context found. Ensure session is initialized before using plan tools "
        "(missing task-local plan session context or AGENT_SESSION_ROOT / AGENT_SESSION_ID)."
    )


def plan_path() -> tuple[Path, str]:
    base, session_id = resolve_session_base()
    return base / "plan.json", session_id


def load_plan_if_exists() -> list[dict[str, str]] | None:
    path, session_id = plan_path()
    if not path.exists():
        return None

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Corrupted plan file for session {session_id}: {exc}") from exc

    if not isinstance(value, dict):
        raise ValueError("Corrupted plan file: expected an object.")
    if value.get("schema_version") != PLAN_SCHEMA_VERSION:
        return None
    if set(value) != {"schema_version", "plan"}:
        raise ValueError("Corrupted v2 plan file: unexpected fields.")
    try:
        return normalize_plan(value["plan"])
    except ValueError as exc:
        raise ValueError(f"Corrupted v2 plan file: {exc}") from exc


def write_plan(plan: list[dict[str, str]]) -> None:
    path, _ = plan_path()
    payload: dict[str, Any] = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "plan": plan,
    }
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
