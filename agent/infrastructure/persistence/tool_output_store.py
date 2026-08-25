"""Session-scoped storage for complete tool output."""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from pathlib import Path

from agent.infrastructure.paths import resolve_rind_home, resolve_session_base, validate_session_id


_RETENTION_SECONDS = 7 * 24 * 60 * 60
_CALL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,160}$")


class ToolOutputStore:
    """Persist complete tool results outside the model context."""

    def __init__(self, session_dir: str | None = None, retention_seconds: int = _RETENTION_SECONDS) -> None:
        self._session_root = (
            Path(session_dir).expanduser().resolve()
            if session_dir
            else (resolve_rind_home() / "sessions").resolve()
        )
        self._retention_seconds = max(1, int(retention_seconds))

    def session_output_root(self, session_id: str) -> Path:
        return resolve_session_base(self._session_root, validate_session_id(session_id)) / "tool-output"

    def path_for(self, session_id: str, call_id: str) -> str:
        if not _CALL_ID_PATTERN.fullmatch(str(call_id or "")):
            raise ValueError("Invalid tool call id for output path.")
        return str((self.session_output_root(session_id) / f"{call_id}.txt").resolve())

    async def write(self, session_id: str, call_id: str, content: str) -> str:
        return await asyncio.to_thread(self._write_sync, session_id, call_id, content)

    async def cleanup(self) -> None:
        await asyncio.to_thread(self._cleanup_sync)

    def _write_sync(self, session_id: str, call_id: str, content: str) -> str:
        target = Path(self.path_for(session_id, call_id))
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(str(content), encoding="utf-8")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return str(target)

    def _cleanup_sync(self) -> None:
        cutoff = time.time() - self._retention_seconds
        if not self._session_root.is_dir():
            return
        for output_dir in self._session_root.glob("*/tool-output"):
            if not output_dir.is_dir():
                continue
            for path in output_dir.iterdir():
                if not path.is_file() or path.name.startswith("."):
                    continue
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink()
                except OSError:
                    continue


__all__ = ["ToolOutputStore"]
