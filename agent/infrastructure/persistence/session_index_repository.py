"""Repository for session index operations."""

from __future__ import annotations

import logging
import os
from typing import Any
from filelock import Timeout
from agent.infrastructure.persistence.session_files import SessionFiles


logger = logging.getLogger(__name__)


# Lists re-read the whole index on every call; it changes only when a session is
# saved, so the parsed result is reused until the file's identity changes.
# Readers treat it as read-only; writers read fresh under the file lock.
# Bounded so many session folders cannot grow it without limit.
_INDEX_CACHE: dict[str, tuple[tuple[int, ...], dict[str, Any]]] = {}


class SessionIndexRepository:
    def __init__(self, files: SessionFiles, index_path: str):
        self._files = files
        self._index_path = index_path

    def load_index(self) -> dict[str, Any]:
        if not self._index_path or not os.path.exists(self._index_path):
            return {"sessions": []}
        try:
            identity = os.stat(self._index_path)
        except OSError:
            return {"sessions": []}
        key = os.path.abspath(self._index_path)
        signature = (identity.st_dev, identity.st_ino, identity.st_ctime_ns, identity.st_mtime_ns, identity.st_size)
        cached = _INDEX_CACHE.get(key)
        if cached and cached[0] == signature:
            return cached[1]
        data = self._read_index()
        # Do not label a concurrent replacement with the identity of the old file.
        try:
            after = os.stat(self._index_path)
        except OSError:
            return data
        if signature != (after.st_dev, after.st_ino, after.st_ctime_ns, after.st_mtime_ns, after.st_size):
            return data
        if len(_INDEX_CACHE) >= 8:
            _INDEX_CACHE.clear()
        _INDEX_CACHE[key] = (signature, data)
        return data

    def _read_index(self) -> dict[str, Any]:
        data = self._files.load_json(self._index_path)
        if not isinstance(data, dict) or "sessions" not in data:
            return {"sessions": []}
        if not isinstance(data.get("sessions"), list):
            return {"sessions": []}
        return data

    def update_index(self, entry: dict[str, Any]) -> bool:
        if not self._index_path:
            return False

        try:
            lock = self._files.lock_for(self._index_path)
            with lock:
                index_data = self._read_index()
                sessions = index_data.get("sessions", [])
                updated = False
                for i, session in enumerate(sessions):
                    if session.get("id") == entry.get("id"):
                        sessions[i] = entry
                        updated = True
                        break
                if not updated:
                    sessions.append(entry)
                index_data["sessions"] = sessions
                self._files.write_json(self._index_path, index_data)
                self._invalidate()
            return True
        except (OSError, RuntimeError, Timeout, ValueError) as exc:
            logger.warning("Failed to update session index %s: %s", self._index_path, exc)
            return False

    def remove_session(self, session_id: str) -> None:
        if not self._index_path or not os.path.exists(self._index_path):
            # Nothing was indexed yet; locking would create a folder for a
            # conversation that never reached disk.
            return

        try:
            lock = self._files.lock_for(self._index_path)
            with lock:
                index_data = self._read_index()
                sessions = index_data.get("sessions", [])
                remaining = [session for session in sessions if session.get("id") != session_id]
                if len(remaining) == len(sessions):
                    return
                index_data["sessions"] = remaining
                self._files.write_json(self._index_path, index_data)
                self._invalidate()
        except (OSError, RuntimeError, Timeout, ValueError) as exc:
            logger.warning("Failed to remove session from index %s: %s", self._index_path, exc)

    def _invalidate(self) -> None:
        _INDEX_CACHE.pop(os.path.abspath(self._index_path), None)
