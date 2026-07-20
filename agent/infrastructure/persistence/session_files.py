"""Base file operations for session persistence."""

from __future__ import annotations

import json
import os
import uuid
from filelock import FileLock, Timeout

class SessionFiles:
    def __init__(self):
        self._locks = {}

    def _get_lock_for_path(self, path: str):
        lock_path = f"{path}.lock"
        if lock_path not in self._locks:
            self._locks[lock_path] = FileLock(lock_path, timeout=5)
        return self._locks[lock_path]

    def load_json(self, path: str) -> dict | None:
        if not os.path.exists(path):
            return None
        try:
            with self._get_lock_for_path(path):
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Timeout as e:
            raise RuntimeError(f"Session is currently in use by another process. Failed to acquire lock for: {path}") from e
        except json.JSONDecodeError as e:
            raise ValueError(f"Corrupted JSON file: {path}: {e}") from e
        except OSError as e:
            raise RuntimeError(f"Failed to read JSON file: {path}: {e}") from e

    def write_json(self, path: str, data: dict) -> None:
        tmp = f"{path}.{uuid.uuid4().hex}.tmp"
        try:
            with self._get_lock_for_path(path):
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, path)
        except Timeout as e:
            self._remove_tmp(tmp)
            raise RuntimeError(f"Session is currently in use by another process. Failed to acquire lock for: {path}") from e
        except Exception:
            self._remove_tmp(tmp)
            raise

    def append_jsonl(self, path: str, data: dict) -> None:
        line = json.dumps(data, ensure_ascii=False)
        try:
            with self._get_lock_for_path(path):
                with open(path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
                    f.flush()
                    os.fsync(f.fileno())
        except Timeout as e:
            raise RuntimeError(f"Session is currently in use by another process. Failed to acquire lock for: {path}") from e

    def read_jsonl(self, path: str) -> list[dict]:
        if not os.path.exists(path):
            return []
        items = []
        with self._get_lock_for_path(path):
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        items.append(json.loads(line))
                    except Exception:
                        continue
        return items

    def _remove_tmp(self, path: str) -> None:
        try:
            if os.path.exists(path):
                os.unlink(path)
        except Exception:
            pass
