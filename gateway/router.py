"""Session routing: deterministic session keys and the persisted mapping.

``session_key`` is the single routing oracle (D6, pure function, no IO).  The
key→(session_id, cursor) mapping persists to ``state.json`` with atomic writes
(temp file + ``os.replace``); a corrupt file is renamed to
``state.json.corrupt`` and routing restarts empty instead of crashing.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import InboundMessage

logger = logging.getLogger(__name__)

# Mirrors agent.runtime.server.protocol RuntimeMethod.SESSION_NEW; kept as a
# local constant so this module stays importable without the agent package.
SESSION_NEW_METHOD = "session/new"
STATE_VERSION = 1


class SessionCreateError(Exception):
    """Raised when session/new keeps failing after one retry."""


def session_key(message: InboundMessage) -> str:
    key = f"{message.channel}:{message.chat_type}:{message.chat_id}"
    if message.thread_id:
        return f"{key}:{message.thread_id}"
    return key


@dataclass(slots=True)
class SessionRecord:
    session_id: str
    cursor: int = 0


class SessionRouter:
    """key↔session_id mapping with cursor tracking, persisted to state.json."""

    def __init__(self, state_path: Path) -> None:
        self._path = Path(state_path)
        self._records: dict[str, SessionRecord] = {}
        self._keys_by_session: dict[str, str] = {}
        self._load()

    def lookup(self, key: str) -> SessionRecord | None:
        return self._records.get(key)

    def key_for_session(self, session_id: str) -> str | None:
        return self._keys_by_session.get(session_id)

    def all_sessions(self) -> dict[str, SessionRecord]:
        return dict(self._records)

    def cursor_for(self, key: str) -> int:
        record = self._records.get(key)
        return record.cursor if record else 0

    async def ensure_session(self, key: str, worker: Any, workspace_root: str) -> SessionRecord:
        """Resolve the mapped session or create one (one retry, then raise)."""
        record = self._records.get(key)
        if record is not None:
            return record
        return await self.create_session(key, worker, workspace_root)

    async def create_session(self, key: str, worker: Any, workspace_root: str) -> SessionRecord:
        """Always create a fresh session and re-bind key → new id (/new).

        The previous session keeps its key mapping in ``_keys_by_session`` so
        events of a still-running old turn keep routing to the chat.
        """
        last_error: Exception | None = None
        for _attempt in range(2):
            try:
                result = await worker.request(
                    SESSION_NEW_METHOD,
                    {"workspace_root": workspace_root, "owner_agent_id": f"gateway:{key}"},
                )
                session_id = str((result or {}).get("session_id") or "").strip()
                if not session_id:
                    raise SessionCreateError("session/new returned no session_id")
                return self._register(key, session_id)
            except Exception as exc:  # noqa: BLE001 - retried once, then raised
                last_error = exc
        raise SessionCreateError(f"session/new failed for {key}: {last_error}") from last_error

    def update_cursor(self, key: str, cursor: int) -> bool:
        """Advance the durable-event cursor for a session; True when stored."""
        record = self._records.get(key)
        if record is None or cursor <= record.cursor:
            return False
        record.cursor = cursor
        self._save()
        return True

    def _register(self, key: str, session_id: str) -> SessionRecord:
        record = SessionRecord(session_id=session_id)
        self._records[key] = record
        self._keys_by_session[session_id] = key
        self._save()
        return record

    def _load(self) -> None:
        if not self._path.is_file():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            sessions = data["sessions"]
            if not isinstance(sessions, dict):
                raise ValueError("sessions must be an object")
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            corrupt = self._path.parent / (self._path.name + ".corrupt")
            os.replace(self._path, corrupt)
            logger.warning("gateway: %s was corrupt; renamed to %s and starting empty", self._path, corrupt)
            return
        for key, entry in sessions.items():
            if not isinstance(entry, dict):
                continue
            session_id = str(entry.get("session_id") or "").strip()
            if not session_id:
                continue
            cursor = entry.get("cursor")
            self._records[str(key)] = SessionRecord(
                session_id=session_id,
                cursor=cursor if isinstance(cursor, int) and cursor >= 0 else 0,
            )
            self._keys_by_session[session_id] = str(key)

    def _save(self) -> None:
        payload = json.dumps(
            {
                "version": STATE_VERSION,
                "sessions": {
                    key: {"session_id": record.session_id, "cursor": record.cursor}
                    for key, record in self._records.items()
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._path.with_name(self._path.name + ".tmp")
        temp.write_text(payload, encoding="utf-8")
        os.replace(temp, self._path)


__all__ = ["SessionCreateError", "SessionRecord", "SessionRouter", "session_key"]
