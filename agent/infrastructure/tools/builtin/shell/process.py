from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Literal
from pathlib import Path

from .capture import StreamCapture


ProcessStatus = Literal[
    "starting", "running", "completed", "failed", "cancelled", "timed_out"
]


@dataclass(slots=True)
class ProcessRecord:
    process_id: str
    session_id: str
    process: asyncio.subprocess.Process
    cwd: str
    shell_backend: str
    shell_executable: str | None
    background: bool
    expires_at: float | None
    call_id: str = ""
    output_store: object | None = None
    status: ProcessStatus = "starting"
    stdout: StreamCapture = field(default_factory=StreamCapture)
    stderr: StreamCapture = field(default_factory=StreamCapture)
    stdout_cursor: int = 0
    stderr_cursor: int = 0
    sequence: int = 0
    empty_observation_count: int = 0
    exit_code: int | None = None
    last_output_at: float = field(default_factory=time.monotonic)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    readers: tuple[asyncio.Task[None], asyncio.Task[None]] | None = None
    monitor: asyncio.Task[None] | None = None
    output_path: str | None = None
    _full_output_chunks: list[bytes] = field(default_factory=list, repr=False)
    _full_output_file: object | None = field(default=None, repr=False)
    _full_output_bytes: int = 0
    _full_output_lines: int = 0

    def append_full_output(self, raw: bytes) -> None:
        if not raw:
            return
        self._full_output_bytes += len(raw)
        self._full_output_lines += raw.count(b"\n")
        if self._full_output_file is not None:
            self._full_output_file.write(raw)
            self._full_output_file.flush()
            return
        self._full_output_chunks.append(raw)
        if self.output_store is None:
            if self._full_output_bytes > 50 * 1024 or self._full_output_lines > 2000:
                self._full_output_chunks.clear()
            return
        if self._full_output_bytes <= 50 * 1024 and self._full_output_lines <= 2000:
            return
        path_for = getattr(self.output_store, "path_for", None)
        if not callable(path_for):
            return
        self.output_path = str(path_for(self.session_id, self.call_id))
        target = Path(self.output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._full_output_file = target.open("wb")
        for chunk in self._full_output_chunks:
            self._full_output_file.write(chunk)
        self._full_output_file.flush()
        self._full_output_chunks.clear()

    def close_full_output(self) -> None:
        if self._full_output_file is not None:
            self._full_output_file.flush()
            self._full_output_file.close()
            self._full_output_file = None
        self._full_output_chunks.clear()
