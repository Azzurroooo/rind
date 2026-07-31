from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Literal

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
