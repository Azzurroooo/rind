"""Session-local plan file storage helpers."""

from __future__ import annotations

import json
import os
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agent.infrastructure.paths import resolve_session_base as resolve_checked_session_base
from agent.infrastructure.paths import validate_session_id

_ACTIVE_SESSION_ROOT: ContextVar[str | None] = ContextVar("tangerine_plan_session_root", default=None)
_ACTIVE_SESSION_ID: ContextVar[str | None] = ContextVar("tangerine_plan_session_id", default=None)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def set_active_session_context(session_root: str, session_id: str) -> None:
    root = str(session_root or "").strip()
    sid = str(session_id or "").strip()
    if not root or not sid:
        return
    sid = validate_session_id(sid)
    _ACTIVE_SESSION_ROOT.set(root)
    _ACTIVE_SESSION_ID.set(sid)


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


def plan_paths() -> tuple[Path, Path, str]:
    base, session_id = resolve_session_base()
    return base / "plan.json", base / "plan_events.jsonl", session_id


def load_plan() -> tuple[dict[str, Any], Path, Path]:
    plan_file, events_file, session_id = plan_paths()
    if not plan_file.exists():
        raise FileNotFoundError(f"No plan found in current session: {session_id}")
    try:
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Corrupted plan file: {exc}") from exc
    if not isinstance(plan, dict):
        raise ValueError("Corrupted plan file: expected object.")
    return plan, plan_file, events_file


def load_plan_if_exists() -> dict[str, Any] | None:
    plan_file, _, _ = plan_paths()
    if not plan_file.exists():
        return None
    try:
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Corrupted plan file: {exc}") from exc
    if not isinstance(plan, dict):
        raise ValueError("Corrupted plan file: expected object.")
    return plan


def append_event(events_file: Path, event: dict[str, Any]) -> None:
    line = json.dumps(event, ensure_ascii=False)
    with events_file.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    tmp = write_json_temp(path, data)
    os.replace(tmp, path)


def write_json_temp(path: Path, data: dict[str, Any]) -> Path:
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    return tmp


def bump_version(plan: dict[str, Any]) -> tuple[int, int]:
    old = int(plan.get("version", 0))
    new = old + 1
    plan["version"] = new
    plan["updated_at"] = now_iso()
    return old, new


def persist_plan_update(
    *,
    plan: dict[str, Any],
    plan_file: Path,
    events_file: Path,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    old_version, new_version = bump_version(plan)
    event = {
        "event_id": uuid.uuid4().hex,
        "ts": now_iso(),
        "actor": "agent",
        "plan_id": plan.get("plan_id"),
        "type": event_type,
        "payload": payload,
        "from_version": old_version,
        "to_version": new_version,
    }
    tmp_plan_file = write_json_temp(plan_file, plan)
    try:
        append_event(events_file, event)
        os.replace(tmp_plan_file, plan_file)
    finally:
        if tmp_plan_file.exists():
            tmp_plan_file.unlink()
