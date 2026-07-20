"""Repository for compact boundary records."""

from __future__ import annotations

from typing import Any

from agent.infrastructure.persistence.session_files import SessionFiles


class CompactionRepository:
    def __init__(self, files: SessionFiles, path: str):
        self._files = files
        self._path = path

    def persist_compaction(self, record: dict[str, Any]) -> dict[str, Any]:
        stored = dict(record)
        self._files.append_jsonl(self._path, stored)
        return stored

    def load_compactions(self) -> list[dict[str, Any]]:
        return self._files.read_jsonl(self._path)

    def get_latest_compaction(self) -> dict[str, Any] | None:
        records = self.load_compactions()
        if not records:
            return None
        return dict(records[-1])
