"""Session-local plan file storage."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from agent.domain.planning import PLAN_SCHEMA_VERSION, PLAN_STEP_STATUSES, normalize_plan


def plan_path(session_base: str | Path | None) -> Path:
    if session_base is None or not Path(session_base).is_dir():
        raise FileNotFoundError("No persisted session. Initialize the session before using plan tools.")
    return Path(session_base) / "plan.json"


def load_plan_if_exists(session_base: str | Path | None) -> list[dict[str, str]] | None:
    path = plan_path(session_base)
    if not path.exists():
        return None

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Corrupted plan file for session {path.parent.name}: {exc}") from exc

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


def write_plan(plan: list[dict[str, str]], session_base: str | Path | None) -> None:
    path = plan_path(session_base)
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


DEFAULT_SUMMARY_CHAR_LIMIT = 2200



TRUNCATION_HINT = "\n...(plan summary truncated due to context budget)..."



def render_plan_summary(plan: list[dict[str, str]], char_limit: int = DEFAULT_SUMMARY_CHAR_LIMIT) -> str:
    if not plan:
        return ""

    counts = {status: 0 for status in PLAN_STEP_STATUSES}
    lines = ["Active plan:"]
    for item in plan:
        status = item["status"]
        counts[status] += 1
        lines.append(f"- [{status}] {item['step']}")
    lines.append(
        "- Progress: "
        + ", ".join(f"{status}={counts[status]}" for status in ("completed", "in_progress", "pending", "cancelled"))
    )
    return _truncate("\n".join(lines), char_limit)



def build_plan_snapshot(session_base: str | Path | None, char_limit: int = 1800) -> str:
    try:

        plan = load_plan_if_exists(session_base)
    except Exception:
        return ""
    return render_plan_summary(plan or [], char_limit=max(0, int(char_limit)))



def _truncate(text: str, char_limit: int) -> str:
    limit = max(0, int(char_limit))
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit <= len(TRUNCATION_HINT):
        return TRUNCATION_HINT[:limit]
    return text[: limit - len(TRUNCATION_HINT)].rstrip() + TRUNCATION_HINT
