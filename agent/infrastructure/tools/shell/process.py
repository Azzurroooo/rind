from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from agent.infrastructure.tools.shell.capture import StreamCapture
from agent.infrastructure.persistence.task_output import TaskOutput


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
    origin_turn_id: str = ""
    request_id: str | None = None
    notify: str = "on_exit"
    process: asyncio.subprocess.Process | None = None
    status: str = "starting"
    reason: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    stdout: StreamCapture = field(default_factory=StreamCapture)
    stderr: StreamCapture = field(default_factory=StreamCapture)
    exit_code: int | None = None
    last_output_at: float = field(default_factory=time.monotonic)
    last_output_event_at: float = 0
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    started: asyncio.Event = field(default_factory=asyncio.Event)
    waiters: set[asyncio.Event] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    handed_off: bool = False
    readers: tuple[asyncio.Task, asyncio.Task] | None = None
    monitor: asyncio.Task | None = None
    deadline: asyncio.Task | None = None
    output: TaskOutput | None = None
    termination_status: str | None = None
