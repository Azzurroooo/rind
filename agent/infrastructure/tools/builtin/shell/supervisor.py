from __future__ import annotations

import asyncio
import codecs
import os
import time
import uuid
from typing import Literal

from agent.domain import tool_ok
from agent.domain.cancellation import CancellationToken
from agent.domain.tool_result import ToolExecutionResult

from .capture import StreamCapture
from .process import ProcessRecord
from .process_tree import kill_tree_now, spawn_group_args, terminate_tree, wait_parent_exit
from .result import (
    background_payload,
    cancelled_result,
    cd_result,
    completed_result,
    delta_output,
    error_result,
    not_found,
    output_meta,
)
from .session_pool import ShellState


class ProcessSupervisor:
    MIN_WAIT_MS = 1000
    MAX_WAIT_MS = 60000
    BACKGROUND_OUTPUT_MIN_WAIT_MS = 5000
    BACKGROUND_OUTPUT_MAX_WAIT_MS = 300000
    BACKGROUND_OUTPUT_DEFAULT_WAIT_MS = 15000
    MAX_OUTPUT_CHARS = 40000
    TERMINATION_GRACE_SECONDS = 1.0
    PIPE_IDLE_GRACE_SECONDS = 0.25

    def __init__(
        self,
        timeout: int = 120,
        max_background_processes: int = 8,
        background_ttl_seconds: float = 3600,
    ) -> None:
        self.timeout = timeout
        self.max_background_processes = max_background_processes
        self.background_ttl_seconds = background_ttl_seconds
        self._processes: dict[str, ProcessRecord] = {}

    async def run(
        self,
        command: str,
        state: ShellState,
        session_id: str,
        cancellation_token: CancellationToken | None = None,
    ) -> ToolExecutionResult:
        cd_result = self._handle_cd(command, state)
        if cd_result:
            return cd_result
        record: ProcessRecord | None = None
        try:
            record = await self._spawn(command, state, session_id, background=False)
            outcome = await self._wait(record, self.timeout, cancellation_token)
            reason = None
            if outcome == "cancelled":
                reason = cancellation_token.reason if cancellation_token else None
                await self._terminate(record, "cancelled")
            elif outcome == "deadline":
                await self._terminate(record, "timed_out")
            else:
                await self._finish_monitor(record)
            return completed_result("bash", record, self.timeout, reason)
        except asyncio.CancelledError:
            if record:
                await self._terminate(record, "cancelled")
            raise
        except Exception as exc:
            return error_result(exc)
        finally:
            if record:
                self._processes.pop(record.process_id, None)

    async def run_background(
        self,
        command: str,
        state: ShellState,
        session_id: str,
        wait_ms: int = 10000,
        cancellation_token: CancellationToken | None = None,
    ) -> ToolExecutionResult:
        cd_result = self._handle_cd(command, state)
        if cd_result:
            return cd_result
        await self._expire_backgrounds()
        if self._background_count() >= self.max_background_processes:
            return ToolExecutionResult(
                status="error",
                error_msg=f"Background process limit reached ({self.max_background_processes}).",
                error_type="BackgroundLimitExceeded",
            )

        record: ProcessRecord | None = None
        try:
            started = time.monotonic()
            record = await self._spawn(command, state, session_id, background=True)
            wait_ms = self._clamp(
                wait_ms, 10000, self.MIN_WAIT_MS, self.MAX_WAIT_MS
            )
            outcome = await self._wait(record, wait_ms / 1000, cancellation_token)
            if outcome == "cancelled":
                reason = cancellation_token.reason if cancellation_token else None
                await self._terminate(record, "cancelled")
                self._processes.pop(record.process_id, None)
                return completed_result("bash", record, self.timeout, reason)
            if record.finished.is_set():
                self._processes.pop(record.process_id, None)
                await self._finish_monitor(record)
                return completed_result("bash", record, self.timeout)

            stdout, stderr, truncated = delta_output(record, 20000)
            payload = background_payload(
                record,
                stdout,
                stderr,
                wait_ms,
                int((time.monotonic() - started) * 1000),
                not stdout and not stderr,
            )
            payload.update(
                {
                    "message": f"Background process started: {command[:200]}",
                    "cwd": state.cwd,
                    "shell_backend": state.shell_backend,
                    "shell_executable": state.shell_executable,
                }
            )
            return ToolExecutionResult(
                status="ok",
                result_str=tool_ok(
                    "bash",
                    payload,
                    meta=output_meta(record, truncated),
                ),
            )
        except asyncio.CancelledError:
            if record:
                self._processes.pop(record.process_id, None)
                await self._terminate(record, "cancelled")
            raise
        except Exception as exc:
            if record:
                self._processes.pop(record.process_id, None)
            return error_result(exc)

    async def read_background(
        self,
        process_id: str,
        session_id: str,
        wait_ms: int = 15000,
        max_output_chars: int = 20000,
        cancellation_token: CancellationToken | None = None,
    ) -> ToolExecutionResult:
        await self._expire_backgrounds()
        record = self._processes.get(process_id)
        if not record or not record.background or record.session_id != session_id:
            return not_found(process_id)

        wait_ms = self._clamp(
            wait_ms,
            self.BACKGROUND_OUTPUT_DEFAULT_WAIT_MS,
            self.BACKGROUND_OUTPUT_MIN_WAIT_MS,
            self.BACKGROUND_OUTPUT_MAX_WAIT_MS,
        )
        max_output_chars = self._clamp(max_output_chars, 20000, 1, self.MAX_OUTPUT_CHARS)
        started = time.monotonic()
        stdout, stderr, truncated = delta_output(record, max_output_chars)
        if not stdout and not stderr and not record.finished.is_set():
            outcome = await self._wait(
                record, wait_ms / 1000, cancellation_token, stop_on_output=True
            )
            if outcome == "cancelled":
                self._processes.pop(process_id, None)
                await self._terminate(record, "cancelled")
                return cancelled_result("bash_output", record)
            stdout, stderr, truncated = delta_output(record, max_output_chars)

        payload = background_payload(
            record,
            stdout,
            stderr,
            wait_ms,
            int((time.monotonic() - started) * 1000),
            not stdout and not stderr and not record.finished.is_set(),
        )
        if record.finished.is_set():
            self._processes.pop(process_id, None)
            await self._finish_monitor(record)
        return ToolExecutionResult(
            status="ok",
            result_str=tool_ok(
                "bash_output", payload, meta=output_meta(record, truncated)
            ),
            exit_code=payload["exit_code"],
        )

    async def cancel_background(self, process_id: str, session_id: str) -> ToolExecutionResult:
        record = self._processes.get(process_id)
        if not record or not record.background or record.session_id != session_id:
            return not_found(process_id)
        self._processes.pop(process_id, None)
        await self._terminate(record, "cancelled")
        return cancelled_result("bash_output", record)

    async def close_session(self, session_id: str) -> None:
        records = [
            record for record in self._processes.values() if record.session_id == session_id
        ]
        for record in records:
            self._processes.pop(record.process_id, None)
        await asyncio.gather(
            *(self._terminate(record, "cancelled") for record in records),
            return_exceptions=True,
        )

    def close_now(self) -> None:
        records = list(self._processes.values())
        self._processes.clear()
        for record in records:
            kill_tree_now(record.process)

    async def _spawn(
        self, command: str, state: ShellState, session_id: str, background: bool
    ) -> ProcessRecord:
        process = await asyncio.create_subprocess_exec(
            *self._build_shell_cmd(command, state),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=state.cwd,
            env=state.env,
            **spawn_group_args(),
        )
        process_id = f"bg_{uuid.uuid4().hex[:8]}" if background else uuid.uuid4().hex
        record = ProcessRecord(
            process_id=process_id,
            session_id=session_id,
            process=process,
            cwd=state.cwd,
            shell_backend=state.shell_backend,
            shell_executable=state.shell_executable,
            background=background,
            expires_at=(
                time.monotonic() + self.background_ttl_seconds if background else None
            ),
        )
        self._processes[process_id] = record
        record.readers = (
            asyncio.create_task(self._read_stream(process.stdout, record.stdout, record)),
            asyncio.create_task(self._read_stream(process.stderr, record.stderr, record)),
        )
        record.status = "running"
        record.monitor = asyncio.create_task(self._monitor(record))
        return record

    async def _monitor(self, record: ProcessRecord) -> None:
        try:
            record.exit_code = await wait_parent_exit(record.process)
            if record.status == "running":
                record.status = "completed" if record.exit_code == 0 else "failed"
                await terminate_tree(record.process, self.TERMINATION_GRACE_SECONDS)
        finally:
            await self._settle_readers(record)
            record.finished.set()
            record.updated.set()

    async def _read_stream(
        self,
        stream: asyncio.StreamReader,
        capture: StreamCapture,
        record: ProcessRecord,
    ) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while raw := await stream.read(4096):
            capture.append(raw, decoder.decode(raw, False))
            record.last_output_at = time.monotonic()
            record.updated.set()
        flushed = decoder.decode(b"", True)
        if flushed:
            capture.append(b"", flushed)
            record.last_output_at = time.monotonic()
            record.updated.set()

    async def _wait(
        self,
        record: ProcessRecord,
        timeout: float,
        cancellation_token: CancellationToken | None,
        stop_on_output: bool = False,
    ) -> Literal["finished", "output", "cancelled", "deadline"]:
        if record.finished.is_set():
            return "finished"
        if cancellation_token and cancellation_token.is_cancelled:
            return "cancelled"

        tasks = {"finished": asyncio.create_task(record.finished.wait())}
        if stop_on_output:
            record.updated.clear()
            tasks["output"] = asyncio.create_task(record.updated.wait())
        if cancellation_token:
            tasks["cancelled"] = asyncio.create_task(cancellation_token.wait())
        try:
            done, _ = await asyncio.wait(
                tasks.values(), timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
            for name in ("cancelled", "finished", "output"):
                if name in tasks and tasks[name] in done:
                    return name
            return "deadline"
        finally:
            for task in tasks.values():
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    async def _terminate(
        self, record: ProcessRecord, status: Literal["cancelled", "timed_out"]
    ) -> None:
        if record.finished.is_set():
            await self._finish_monitor(record)
            return
        record.status = status
        await terminate_tree(record.process, self.TERMINATION_GRACE_SECONDS)
        try:
            await asyncio.wait_for(record.finished.wait(), self.TERMINATION_GRACE_SECONDS)
        except asyncio.TimeoutError:
            if record.monitor:
                record.monitor.cancel()
                await asyncio.gather(record.monitor, return_exceptions=True)

    async def _finish_monitor(self, record: ProcessRecord) -> None:
        if record.monitor:
            await record.monitor

    async def _settle_readers(self, record: ProcessRecord) -> None:
        if not record.readers:
            return
        deadline = time.monotonic() + self.TERMINATION_GRACE_SECONDS
        pending = set(record.readers)
        while pending:
            remaining = min(
                deadline - time.monotonic(),
                record.last_output_at + self.PIPE_IDLE_GRACE_SECONDS - time.monotonic(),
            )
            if remaining <= 0:
                break
            _, pending = await asyncio.wait(
                pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
            )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            if isinstance(record.process, asyncio.subprocess.Process):
                record.process._transport.close()

    async def _expire_backgrounds(self) -> None:
        now = time.monotonic()
        expired = [
            record
            for record in self._processes.values()
            if record.background and record.expires_at is not None and record.expires_at <= now
        ]
        for record in expired:
            self._processes.pop(record.process_id, None)
        await asyncio.gather(
            *(
                self._terminate(record, "timed_out")
                for record in expired
                if not record.finished.is_set()
            ),
            return_exceptions=True,
        )

    def _handle_cd(self, command: str, state: ShellState) -> ToolExecutionResult | None:
        if not command.strip().startswith("cd "):
            return None
        target = command.strip()[3:].strip()
        if target.startswith("~"):
            target = os.path.expanduser(target)
        path = os.path.abspath(os.path.join(state.cwd, target))
        if os.path.isdir(path):
            state.cwd = path
            return cd_result(state, f"Changed directory to: {path}", 0)
        return cd_result(state, f"cd: no such file or directory: {target}", 1)

    def _background_count(self) -> int:
        return sum(record.background for record in self._processes.values())

    def _build_shell_cmd(self, command: str, state: ShellState) -> list[str]:
        if not state.shell_executable:
            raise RuntimeError(state.shell_error or "Shell executable is not configured.")
        if state.shell_backend == "powershell":
            return [
                state.shell_executable,
                "-NoLogo",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ]
        return [state.shell_executable, "-c", command]

    def _clamp(self, value: object, default: int, minimum: int, maximum: int) -> int:
        try:
            parsed = int(default if value is None else value)
        except (TypeError, ValueError):
            parsed = default
        return max(minimum, min(parsed, maximum))
