from __future__ import annotations

import asyncio
import codecs
import json
from pathlib import Path
import time
import uuid

from agent.domain import tool_ok
from agent.domain.tasks import TERMINAL_STATES, public_task
from agent.domain.cancellation import CancellationToken
from agent.domain.tool_result import ToolExecutionResult
from agent.infrastructure.tools.shell.process import ProcessRecord
from agent.infrastructure.tools.shell.process_tree import close_process_tree, kill_tree_now, own_process_tree, spawn_group_args, terminate_tree, wait_parent_exit
from agent.infrastructure.tools.shell.result import error_result, not_found, task_result, task_snapshot, output_preview
from agent.infrastructure.tools.shell.session_pool import ShellState
from agent.infrastructure.persistence.task_journal import TaskJournal
from agent.infrastructure.persistence.task_output import TaskOutput, read_output_page


class ProcessSupervisor:
    TERMINATION_GRACE_SECONDS = 1.0

    def __init__(self, max_tasks: int = 8, journal: TaskJournal | None = None) -> None:
        self.max_tasks = max_tasks
        self._processes: dict[str, ProcessRecord] = {}
        self._origins: dict[tuple[str, str], str] = {}
        self._closed = False
        self._closed_sessions: set[str] = set()
        self.journal = journal
        self._observer = None

    def set_observer(self, observer) -> None:
        self._observer = observer

    async def run(self, command: str, state: ShellState, session_id: str,
                  cancellation_token: CancellationToken | None = None, *, call_id: str = "",
                  output_store=None, yield_time_ms: int = 10000, timeout_ms: int | None = None,
                  notify: str = "on_exit", origin_turn_id: str = "", request_id: str | None = None) -> ToolExecutionResult:
        self._retire_finished()
        origin = (session_id, call_id)
        existing_id = self._origins.get(origin) if call_id else None
        if existing_id:
            record = self._processes[existing_id]
            await record.started.wait()
            return await self._result("bash", record, "finished" if record.finished.is_set() else "yield_timeout")
        if self._closed or session_id in self._closed_sessions:
            return error_result(RuntimeError("Worker is shutting down."))
        if sum(r.status not in TERMINAL_STATES for r in self._processes.values()) >= self.max_tasks:
            return ToolExecutionResult(status="error", error_type="TaskLimitExceeded", error_msg=f"Running task limit reached ({self.max_tasks}).")
        record = ProcessRecord(task_id=f"task_{uuid.uuid4().hex}", session_id=session_id,
            command=command, cwd=state.cwd, shell_backend=state.shell_backend,
            shell_executable=state.shell_executable, call_id=call_id, notify=notify,
            origin_turn_id=origin_turn_id, request_id=request_id)
        self._processes[record.task_id] = record
        if call_id:
            self._origins[origin] = record.task_id
        try:
            if self.journal:
                intent = await self.journal.save(session_id, {
                    **task_snapshot(record), "worker_instance_id": self.journal.worker_instance_id,
                    "committed": False, "handoff": False, "delivered": False,
                }, create=True)
                if intent["task_id"] != record.task_id:
                    self._processes.pop(record.task_id, None)
                    self._origins.pop(origin, None)
                    record.started.set()
                    return self._stored_result("bash", intent)
            if output_store is not None:
                record.output = TaskOutput(Path(output_store.path_for(session_id, record.task_id)), record.task_id)
                await record.output.start()
            spawn = asyncio.create_task(self._spawn(record, command, state, timeout_ms))
            try:
                await asyncio.shield(spawn)
            except asyncio.CancelledError:
                await spawn
                raise
            if not await self._save(record):
                raise OSError(record.persistence_error)
            remaining_ms = max(0, yield_time_ms - (time.monotonic() - record.spawned_at) * 1000)
            reason = "released" if record.handed_off else await self._wait(record, remaining_ms, cancellation_token)
            if reason == "interrupted" and not record.handed_off:
                await self._terminate(record, "cancelled", cancellation_token.reason or "User interrupted")
            record.handed_off = not record.finished.is_set()
            result = await self._result("bash", record, reason)
            await self._save(record, handoff=record.handed_off)
            return result
        except asyncio.CancelledError:
            if record.process is not None and not record.handed_off:
                await self._terminate(record, "cancelled", "Initial call interrupted")
            elif record.process is None:
                record.status = "lost"
                record.reason = "Start interrupted; execution ownership cannot be confirmed."
                record.finished_at = time.time()
                record.finished.set()
                if record.output:
                    await record.output.close()
                await self._save(record)
            raise
        except Exception as exc:
            if record.process is not None:
                await self._terminate(record, "failed", str(exc))
                return await self._result("bash", record, "finished" if record.finished.is_set() else "interrupted")
            else:
                record.status = "failed"
                record.reason = str(exc)
                record.finished_at = time.time()
                record.finished.set()
                if record.output:
                    await record.output.close()
                await self._save(record)
            return error_result(exc)
        finally:
            record.started.set()

    async def _spawn(self, record, command, state, timeout_ms):
        record.process = await asyncio.create_subprocess_exec(
            *self._build_shell_cmd(command, state), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=state.cwd, env=state.env, **spawn_group_args())
        record.started_at = time.time()
        record.spawned_at = time.monotonic()
        try:
            record.job = own_process_tree(record.process)
        except Exception:
            kill_tree_now(record.process, record.job)
            record.monitor = asyncio.create_task(self._monitor(record))
            raise
        record.status = "running"
        record.readers = (
            asyncio.create_task(self._read_stream(record.process.stdout, record.stdout, record, "stdout")),
            asyncio.create_task(self._read_stream(record.process.stderr, record.stderr, record, "stderr")))
        record.monitor = asyncio.create_task(self._monitor(record))
        if timeout_ms is not None:
            record.deadline = asyncio.create_task(self._deadline(record, timeout_ms))
        record.started.set()

    async def control(self, action: str, session_id: str, task_id: str | None = None, *,
                      wait_ms: int = 30000, max_output_chars: int = 20000,
                      cancellation_token: CancellationToken | None = None,
                      page_token: str | None = None, cursor: str | None = None) -> ToolExecutionResult:
        self._retire_finished()
        stored = await self.journal.records(session_id) if self.journal else {}
        if action == "list":
            records = {**stored, **{r.task_id: task_snapshot(r) for r in self._processes.values() if r.session_id == session_id}}
            records = sorted(records.values(), key=lambda r: (r["status"] in TERMINAL_STATES, -r["started_at"], r["task_id"]))
            offset = int(page_token or 0)
            page = []
            page_bytes = 0
            for record in records[offset:offset + 50]:
                item = {key: record.get(key) for key in ("task_id", "status", "notify", "command", "started_at", "finished_at", "elapsed_ms", "origin_tool_call_id")}
                item["command"] = str(item["command"] or "")[:160]
                size = len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
                if page and page_bytes + size > 20000:
                    break
                page.append(item)
                page_bytes += size
            return ToolExecutionResult(status="ok", result_str=tool_ok("task_control", {
                "tasks": page,
                "next_page_token": str(offset + len(page)) if offset + len(page) < len(records) else None}))
        record = self._processes.get(task_id)
        if record is None or record.session_id != session_id:
            if task_id in stored:
                snapshot = stored[task_id]
                if action == "cancel" and snapshot["status"] not in TERMINAL_STATES:
                    return ToolExecutionResult(status="error", error_type="TaskNotOwned", error_msg="Task belongs to another active Worker; no process was signalled.")
                return await self._read_stored(snapshot, cursor, max_output_chars)
            return not_found(task_id)
        reason = "finished" if record.finished.is_set() else "yield_timeout"
        if action == "cancel":
            await record.started.wait()
            await self._terminate(record, "cancelled", "Explicit task cancellation")
            reason = "finished" if record.finished.is_set() else "yield_timeout"
        elif action == "wait":
            reason = await self._wait(record, wait_ms, cancellation_token)
        return await self._result("task_control", record, reason, max_output_chars, cursor)

    async def _result(self, tool, record, reason, max_chars=20000, cursor=None):
        if record.output:
            await record.output.flush()
        result = task_result(tool, record, reason, max_chars)
        if cursor is not None:
            if record.output is None:
                raise ValueError("This task has no stored output.")
            page = await record.output.read(cursor, max_chars)
            payload = json.loads(result.result_str)
            payload["data"].update({k: v for k, v in page.items() if k not in {"truncated", "output_incomplete", "output_error"}})
            payload["meta"].update({k: page[k] for k in ("truncated", "output_incomplete", "output_error") if k in page})
            result.result_str = json.dumps(payload, ensure_ascii=False)
        return result

    async def _save(self, record, **changes):
        if self.journal is None:
            return True
        async with record.lock:
            payload = json.loads((await self._result("task_control", record, "finished" if record.status in TERMINAL_STATES else "yield_timeout")).result_str)
            snapshot = {**payload["data"], "meta": payload["meta"], **changes}
            if record.process:
                snapshot["pid"] = record.process.pid
            if record.status in TERMINAL_STATES:
                snapshot["event_id"] = f"{record.task_id}:1"
            try:
                saved = await self.journal.save(record.session_id, snapshot)
            except (OSError, ValueError) as exc:
                record.persistence_error = f"Task journal write failed: {exc}"
                return False
            record.persistence_error = ""
            if self._observer:
                self._observer(saved)
            return True

    @staticmethod
    def _stored_result(tool, snapshot):
        return ToolExecutionResult(status="ok", result_str=tool_ok(tool,
            {k: v for k, v in public_task(snapshot).items() if k != "meta"}, meta=snapshot.get("meta", {})))

    def _retire_finished(self):
        if self.journal:
            for task_id, record in list(self._processes.items()):
                if record.finished.is_set() and not record.persistence_error and (record.monitor is None or record.monitor.done()):
                    self._processes.pop(task_id)
                    self._origins.pop((record.session_id, record.call_id), None)

    async def _read_stored(self, snapshot, cursor, max_chars):
        snapshot = dict(snapshot)
        if cursor is None:
            stdout, stderr = output_preview(snapshot.get("stdout", ""), snapshot.get("stderr", ""), max_chars)
            snapshot["meta"] = {**snapshot.get("meta", {}), "truncated": snapshot.get("meta", {}).get("truncated", False)
                                or len(snapshot.get("stdout", "")) + len(snapshot.get("stderr", "")) > max_chars}
            snapshot.update(stdout=stdout, stderr=stderr)
        if cursor is not None:
            path = snapshot.get("meta", {}).get("output_path")
            if not path:
                raise ValueError("This task has no stored output.")
            page = await asyncio.to_thread(read_output_page, Path(path).with_suffix(".jsonl"), snapshot["task_id"], cursor, max_chars)
            snapshot.update({k: v for k, v in page.items() if k not in {"truncated", "output_incomplete", "output_error"}})
            snapshot["meta"] = {**snapshot.get("meta", {}), **{k: page[k] for k in ("truncated", "output_incomplete", "output_error") if k in page}}
        return self._stored_result("task_control", snapshot)

    def release_wait(self, session_id: str, task_id: str | None = None, call_id: str | None = None) -> bool:
        released = False
        for record in self._processes.values():
            if record.session_id != session_id or (task_id and record.task_id != task_id) or (call_id and record.call_id != call_id):
                continue
            if not record.handed_off and record.status not in TERMINAL_STATES:
                record.handed_off = True
                released = True
            for waiter in record.waiters:
                record.handed_off = True
                waiter.set()
                released = True
        return released

    def stop_accepting(self) -> None:
        self._closed = True

    async def close_session(self, session_id: str) -> None:
        self._closed_sessions.add(session_id)
        records = [r for r in self._processes.values() if r.session_id == session_id]
        await asyncio.gather(*(r.started.wait() for r in records))
        await asyncio.gather(*(self._terminate(r, "cancelled", "Session closed") for r in records))
        for record in records:
            if not record.finished.is_set():
                raise RuntimeError(f"Cannot close session: termination of {record.task_id} is not confirmed.")
            if record.monitor:
                await record.monitor
            self._processes.pop(record.task_id, None)
            self._origins.pop((session_id, record.call_id), None)

    async def close(self) -> None:
        self._closed = True
        records = list(self._processes.values())
        await asyncio.gather(*(r.started.wait() for r in records))
        await asyncio.gather(*(self._terminate(r, "cancelled", "Worker shutting down") for r in records))
        if self.journal:
            await self.journal.close()

    def close_now(self) -> None:
        self._closed = True
        for record in self._processes.values():
            if record.process and not record.finished.is_set():
                kill_tree_now(record.process, record.job)
                close_process_tree(record.job)
                record.job = None
        if self.journal:
            self.journal.close_now()

    async def _deadline(self, record: ProcessRecord, timeout_ms: int) -> None:
        await asyncio.sleep(max(0, timeout_ms / 1000 - (time.monotonic() - record.spawned_at)))
        await self._terminate(record, "timed_out", f"Runtime deadline exceeded ({timeout_ms} ms)")

    async def _monitor(self, record: ProcessRecord) -> None:
        failure_status = None
        try:
            record.exit_code = await wait_parent_exit(record.process)
            await terminate_tree(record.process, self.TERMINATION_GRACE_SECONDS, record.job)
        except Exception as exc:
            failure_status = "lost" if record.exit_code is None else "failed"
            record.reason = f"Process cleanup failed: {exc}"
        finally:
            await self._settle_readers(record)
            if record.output:
                await record.output.close()
            close_process_tree(record.job)
            record.job = None
            record.status = failure_status or record.termination_status or ("completed" if record.exit_code == 0 else "failed")
            record.finished_at = time.time()
            await self._save(record)
            record.finished.set()
            if record.deadline and not record.deadline.done():
                record.deadline.cancel()

    async def _read_stream(self, stream, capture, record: ProcessRecord, stream_name: str) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while raw := await stream.read(16384):
            text = decoder.decode(raw, False)
            capture.append(raw, text)
            if record.output:
                await record.output.append(stream_name, raw, text)
            now = time.monotonic()
            if self._observer and now - record.last_output_event_at >= 0.1:
                record.last_output_event_at = now
                self._observer({**task_snapshot(record), "type": "task_output",
                    "stdout": record.stdout.render()[-2000:], "stderr": record.stderr.render()[-2000:]})
        text = decoder.decode(b"", True)
        capture.append(b"", text)
        if text and record.output:
            await record.output.append(stream_name, b"", text)

    async def _wait(self, record: ProcessRecord, wait_ms: int, cancellation_token) -> str:
        if cancellation_token and cancellation_token.is_cancelled:
            return "interrupted"
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
        if record.status in TERMINAL_STATES or record.process is None or record.process.returncode is not None:
            if record.monitor and not record.finished.is_set():
                await record.finished.wait()
            return
        if record.termination_status is None:
            record.status = "cancelling"
            record.reason = reason
            record.termination_status = status
            await self._save(record)
        if record.status not in TERMINAL_STATES:
            await terminate_tree(record.process, self.TERMINATION_GRACE_SECONDS, record.job)
        try:
            await asyncio.wait_for(record.finished.wait(), self.TERMINATION_GRACE_SECONDS * 2)
        except asyncio.TimeoutError:
            record.reason = f"Termination not confirmed: {reason}"
            await self._save(record)

    async def _settle_readers(self, record: ProcessRecord) -> None:
        if not record.readers:
            return
        _, pending = await asyncio.wait(record.readers, timeout=self.TERMINATION_GRACE_SECONDS)
        for task in pending:
            task.cancel()
        outcomes = await asyncio.gather(*record.readers, return_exceptions=True)
        if record.output and (pending or any(isinstance(value, BaseException) for value in outcomes)):
            record.output.incomplete = record.output.incomplete or "Output pipe could not be fully drained."
        if pending and isinstance(record.process, asyncio.subprocess.Process):
            record.process._transport.close()

    def _build_shell_cmd(self, command: str, state: ShellState) -> list[str]:
        if not state.shell_executable:
            raise RuntimeError(state.shell_error or "Shell executable is not configured.")
        if state.shell_backend == "powershell":
            return [state.shell_executable, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        return [state.shell_executable, "-c", command]
