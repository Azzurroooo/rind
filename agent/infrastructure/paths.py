"""Shared filesystem path rules."""

from __future__ import annotations

import os
import re
from pathlib import Path

_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def resolve_rind_home() -> Path:
    override = os.getenv("RIND_HOME", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".rind").resolve()


def resolve_project_root(cwd: Path | None = None) -> Path:
    return (cwd or Path.cwd()).resolve()


def validate_session_id(session_id: str) -> str:
    value = str(session_id or "")
    if not _SESSION_ID_PATTERN.fullmatch(value) or ".." in value:
        raise ValueError("Invalid session id.")
    return value


def resolve_session_base(session_root: str | Path, session_id: str) -> Path:
    root = Path(session_root).expanduser().resolve()
    return root / validate_session_id(session_id)
