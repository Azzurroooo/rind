"""Repository for persisting and loading messages."""

from __future__ import annotations

import uuid
from typing import Any
from agent.infrastructure.persistence.session_files import SessionFiles

class MessageRepository:
    def __init__(self, files: SessionFiles, path: str):
        self._files = files
        self._path = path

    def persist_message(
        self,
        ts: str,
        role: str,
        content: str,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        meta: dict | None = None,
    ) -> None:
        msg = {"id": uuid.uuid4().hex, "ts": ts, "role": role, "content": content or ""}
        if tool_call_id:
            msg["tool_call_id"] = tool_call_id
        if tool_name:
            msg["tool_name"] = tool_name
        if meta:
            msg["meta"] = meta
        self._files.append_jsonl(self._path, msg)

    def load_messages(self) -> list[dict[str, Any]]:
        return self._files.read_jsonl(self._path)
