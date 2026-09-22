from __future__ import annotations

import asyncio
import codecs
import time
import uuid

from agent.domain import tool_ok
from agent.domain.cancellation import CancellationToken
from agent.domain.tool_result import ToolExecutionResult
from agent.infrastructure.tools.shell.process import ProcessRecord, TERMINAL_STATES
from agent.infrastructure.tools.shell.process_tree import kill_tree_now, spawn_group_args, terminate_tree, wait_parent_exit
from agent.infrastructure.tools.shell.result import error_result, not_found, task_result, task_snapshot
from agent.infrastructure.tools.shell.session_pool import ShellState


class ProcessSupervisor:
    TERMINATION_GRACE_SECONDS = 1.0

    def __init__(self, max_tasks: int = 8) -> None:
        self.max_tasks = max_tasks
        self._processes: dict[str, ProcessRecord] = {}
        self._origins: dict[tuple[str, str], str] = {}
        self._closed = False

    async def run(self, command: str, state: ShellState, session_id: str,
                  cancellation_token: CancellationToken | None = None, *, call_id: str = "",
                  output_store=None, yield_time_ms: int = 10000, timeout_ms: int | None = None,
                  notify: str = "on_exit") -> ToolExecutionResult:
        origin = (session_id, call_id)
        existing_id = self._origins.get(origin) if call_id else None
        if existing_id:
            record = self._processes[existing_id]
            await record.started.wait()
            return task_result("bash", record, "finished" if record.finished.is_set() else "yield_timeout")
        if self._closed:
            return error_result(RuntimeError("Worker is shutting down."))
        if sum(r.status not in TERMINAL_STATES for r in self._processes.values()) >= self.max_tasks:
            return ToolExecutionResult(status="error", error_type="TaskLimitExceeded", error_msg=f"Running task limit reached ({self.max_tasks}).")
        record = ProcessRecord(task_id=f"task_{uuid.uuid4().hex}", session_id=session_id,
            command=command, cwd=state.cwd, shell_backend=state.shell_backend,
            shell_executable=state.shell_executable, call_id=call_id, notify=notify, output_store=output_store)
        self._processes[record.task_id] = record
        if call_id:
            self._origins[origin] = record.task_id
        try:
            record.process = await asyncio.create_subprocess_exec(
                *self._build_shell_cmd(command, state), stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                cwd=state.cwd, env=state.env, **spawn_group_args())
            record.started_at = time.time()
            record.status = "running"
            record.readers = (
                asyncio.create_task(self._read_stream(record.process.stdout, record.stdout, record)),
                asyncio.create_task(self._read_stream(record.process.stderr, record.stderr, record)))
            record.monitor = asyncio.create_task(self._monitor(record))
            if timeout_ms is not None:
                record.deadline = asyncio.create_task(self._deadline(record, timeout_ms))
            record.started.set()
            reason = await self._wait(record, yield_time_ms, cancellation_token)
            if reason == "interrupted" and not record.handed_off:
                await self._terminate(record, "cancelled", cancellation_token.reason or "User interrupted")
            async with record.lock:
                record.handed_off = not record.finished.is_set()
                return task_result("bash", record, reason)
        except asyncio.CancelledError:
            if record.process is not None and not record.handed_off:
                await self._terminate(record, "cancelled", "Initial call interrupted")
            raise
        except Exception as exc:
            if record.process is not None:
                await self._terminate(record, "cancelled", str(exc))
            else:
                record.status = "failed"
                record.reason = str(exc)
                record.finished_at = time.time()
                record.finished.set()
            return error_result(exc)
        finally:
            record.started.set()

    async def control(self, action: str, session_id: str, task_id: str | None = None, *,
                      wait_ms: int = 30000, max_output_chars: int = 20000,
                      cancellation_token: CancellationToken | None = None,
                      page_token: str | None = None) -> ToolExecutionResult:
        if action == "list":
            records = [r for r in self._processes.values() if r.session_id == session_id]
            records.sort(key=lambda r: (r.status in TERMINAL_STATES, -r.started_at, r.task_id))
            offset = int(page_token or 0)
            return ToolExecutionResult(status="ok", result_str=tool_ok("task_control", {
                "tasks": [task_snapshot(r) for r in records[offset:offset + 50]],
                "next_page_token": str(offset + 50) if offset + 50 < len(records) else None}))
        record = self._processes.get(task_id)
        if record is None or record.session_id != session_id:
            return not_found(task_id)
        reason = "finished" if record.finished.is_set() else "yield_timeout"
        if action == "cancel":
            await record.started.wait()
            await self._terminate(record, "cancelled", "Explicit task cancellation")
            reason = "finished" if record.finished.is_set() else "yield_timeout"
        elif action == "wait":
            reason = await self._wait(record, wait_ms, cancellation_token)
        return task_result("task_control", record, reason, max_output_chars)

    def release_wait(self, session_id: str, task_id: str | None = None, call_id: str | None = None) -> bool:
        released = False
        for record in self._processes.values():
            if record.session_id != session_id or (task_id and record.task_id != task_id) or (call_id and record.call_id != call_id):
                continue
            for waiter in record.waiters:
                record.handed_off = True
                waiter.set()
                released = True
        return released

    async def close_session(self, session_id: str) -> None:
        records = [r for r in self._processes.values() if r.session_id == session_id]
        await asyncio.gather(*(r.started.wait() for r in records))
        await asyncio.gather(*(self._terminate(r, "cancelled", "Session closed") for r in records))

    async def close(self) -> None:
        self._closed = True
        records = list(self._processes.values())
        await asyncio.gather(*(r.started.wait() for r in records))
        await asyncio.gather(*(self._terminate(r, "cancelled", "Worker shutting down") for r in records))

    def close_now(self) -> None:
        self._closed = True
        for record in self._processes.values():
            if record.process and not record.finished.is_set():
                kill_tree_now(record.process)
            record.close_full_output()

    async def _deadline(self, record: ProcessRecord, timeout_ms: int) -> None:
        await asyncio.sleep(timeout_ms / 1000)
        await self._terminate(record, "timed_out", f"Runtime deadline exceeded ({timeout_ms} ms)")

    async def _monitor(self, record: ProcessRecord) -> None:
        try:
            record.exit_code = await wait_parent_exit(record.process)
            await terminate_tree(record.process, self.TERMINATION_GRACE_SECONDS)
            await self._settle_readers(record)
            record.close_full_output()
            if record.status != "cancelling":
                record.status = "completed" if record.exit_code == 0 else "failed"
            else:
                record.status = "timed_out" if record.reason.startswith("Runtime deadline") else "cancelled"
        finally:
            record.finished_at = time.time()
            record.finished.set()
            if record.deadline and not record.deadline.done():
                record.deadline.cancel()

    async def _read_stream(self, stream, capture, record: ProcessRecord) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while raw := await stream.read(4096):
            record.append_full_output(raw)
            capture.append(raw, decoder.decode(raw, False))
            record.last_output_at = time.monotonic()
        capture.append(b"", decoder.decode(b"", True))

    async def _wait(self, record: ProcessRecord, wait_ms: int, cancellation_token) -> str:
        if record.finished.is_set():
            return "finished"
        release = asyncio.Event()
        record.waiters.add(release)
        tasks = {"finished": asyncio.create_task(record.finished.wait()), "released": asyncio.create_task(release.wait())}
        if cancellation_token:
            tasks["interrupted"] = asyncio.create_task(cancellation_token.wait())
        try:
            done, _ = await asyncio.wait(tasks.values(), timeout=wait_ms / 1000, return_when=asyncio.FIRST_COMPLETED)
            return next((name for name in ("interrupted", "finished", "released") if tasks.get(name) in done), "yield_timeout")
        finally:
            record.waiters.discard(release)
            for task in tasks.values():
                task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    async def _terminate(self, record: ProcessRecord, status: str, reason: str) -> None:
        if record.finished.is_set() or record.process is None:
            return
        record.status = "cancelling"
        record.reason = reason
        await terminate_tree(record.process, self.TERMINATION_GRACE_SECONDS)
        try:
            await asyncio.wait_for(record.finished.wait(), self.TERMINATION_GRACE_SECONDS * 2)
        except asyncio.TimeoutError:
            record.reason = f"Termination not confirmed: {reason}"

    async def _settle_readers(self, record: ProcessRecord) -> None:
        if not record.readers:
            return
        _, pending = await asyncio.wait(record.readers, timeout=self.TERMINATION_GRACE_SECONDS)
        for task in pending:
            task.cancel()
        await asyncio.gather(*record.readers, return_exceptions=True)
        if pending and isinstance(record.process, asyncio.subprocess.Process):
            record.process._transport.close()

    def _build_shell_cmd(self, command: str, state: ShellState) -> list[str]:
        if not state.shell_executable:
            raise RuntimeError(state.shell_error or "Shell executable is not configured.")
        if state.shell_backend == "powershell":
            return [state.shell_executable, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        return [state.shell_executable, "-c", command]
