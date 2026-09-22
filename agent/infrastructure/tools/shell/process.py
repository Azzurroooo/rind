from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Literal
from pathlib import Path

from agent.infrastructure.tools.shell.capture import StreamCapture


TERMINAL_STATES = frozenset({"completed", "failed", "cancelled", "timed_out", "lost"})


@dataclass(slots=True)
class ProcessRecord:
    task_id: str
    session_id: str
    command: str
    cwd: str
    shell_backend: str
    shell_executable: str | None
    call_id: str = ""
    notify: str = "on_exit"
    process: asyncio.subprocess.Process | None = None
    output_store: object | None = None
    status: str = "starting"
    reason: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    stdout: StreamCapture = field(default_factory=StreamCapture)
    stderr: StreamCapture = field(default_factory=StreamCapture)
    exit_code: int | None = None
    last_output_at: float = field(default_factory=time.monotonic)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    started: asyncio.Event = field(default_factory=asyncio.Event)
    waiters: set[asyncio.Event] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    handed_off: bool = False
    readers: tuple[asyncio.Task, asyncio.Task] | None = None
    monitor: asyncio.Task | None = None
    deadline: asyncio.Task | None = None
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
        self.output_path = str(path_for(self.session_id, self.call_id or self.task_id))
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
