"""Repository for session index operations."""

from __future__ import annotations

import os
from typing import Any
from agent.infrastructure.persistence.session_files import SessionFiles

class SessionIndexRepository:
    def __init__(self, files: SessionFiles, index_path: str):
        self._files = files
        self._index_path = index_path

    def load_index(self) -> dict[str, Any]:
        if not self._index_path or not os.path.exists(self._index_path):
            return {"sessions": []}
        data = self._files.load_json(self._index_path)
        if not isinstance(data, dict) or "sessions" not in data:
            return {"sessions": []}
        if not isinstance(data.get("sessions"), list):
            return {"sessions": []}
        return data

    def update_index(self, entry: dict[str, Any]) -> None:
        if not self._index_path:
            return

        lock = self._files._get_lock_for_path(self._index_path)
        with lock:
            index_data = self.load_index()
            sessions = index_data.get("sessions", [])
            updated = False
            for i, s in enumerate(sessions):
                if s.get("id") == entry.get("id"):
                    sessions[i] = entry
                    updated = True
                    break
            if not updated:
                sessions.append(entry)
            index_data["sessions"] = sessions
            self._files.write_json(self._index_path, index_data)
