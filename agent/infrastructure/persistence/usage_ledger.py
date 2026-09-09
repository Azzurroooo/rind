"""Append-only user-level token usage ledger (~/.rind/usage.jsonl)."""

from __future__ import annotations

import os

from agent.infrastructure.paths import resolve_rind_home
from agent.infrastructure.persistence.session_files import SessionFiles


USAGE_LEDGER_FILENAME = "usage.jsonl"


def default_usage_ledger_path() -> str:
    return str(resolve_rind_home() / USAGE_LEDGER_FILENAME)


def append_usage_record(path: str | os.PathLike, record: dict) -> None:
    """Append one record under the shared file lock; concurrent writers never interleave."""
    SessionFiles().append_jsonl(str(path), dict(record))


def load_usage_records(path: str | os.PathLike) -> list[dict]:
    return SessionFiles().read_jsonl(str(path))
