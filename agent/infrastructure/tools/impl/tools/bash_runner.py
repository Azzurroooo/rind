"""Executes bash commands asynchronously and handles streams."""

from __future__ import annotations

import asyncio
import codecs
import os
import time
import uuid
from collections import deque
from dataclasses import dataclass, field

from agent.domain.tool_result import ToolExecutionResult
from agent.domain import tool_cancelled, tool_error, tool_ok
from agent.application.runtime.cancellation import CancellationToken
from .bash_session_pool import ShellState


@dataclass
class _BgProc:
    """In-flight state for a background process."""
    bg_id: str
    session_id: str
    process: asyncio.subprocess.Process
    command: str
    cwd: str
    shell_backend: str
    shell_executable: str | None
    stdout_head: list[str] = field(default_factory=list)
    stdout_tail: deque = field(default_factory=lambda: deque(maxlen=10000))
    stdout_len: list[int] = field(default_factory=lambda: [0])
    stderr_head: list[str] = field(default_factory=list)
    stderr_tail: deque = field(default_factory=lambda: deque(maxlen=10000))
    stderr_len: list[int] = field(default_factory=lambda: [0])
    stdout_cursor: int = 0
    stderr_cursor: int = 0
    sequence: int = 0
    updated_event: asyncio.Event = field(default_factory=asyncio.Event)
    last_observed_at: float | None = None
    empty_observation_count: int = 0
    exit_code: int | None = None
    _tasks: list[asyncio.Task] = field(default_factory=list)


class BashRunner:
    """Executes bash commands and captures their streams."""

    def __init__(self, timeout: int = 120):
        self.timeout = timeout
        self.HEAD_LIMIT = 10000
        self.TAIL_LIMIT = 10000
        self.MIN_WAIT_MS = 1000
        self.MAX_WAIT_MS = 60000
        self.BACKGROUND_OUTPUT_MIN_WAIT_MS = 5000
        self.BACKGROUND_OUTPUT_MAX_WAIT_MS = 300000
        self.BACKGROUND_OUTPUT_DEFAULT_WAIT_MS = 15000
        self.MAX_OUTPUT_CHARS = 40000
        self._bg: dict[str, _BgProc] = {}

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    def _handle_cd(self, command: str, state: ShellState) -> ToolExecutionResult | None:
        if command.strip().startswith("cd "):
            target_dir = command.strip()[3:].strip()
            if target_dir.startswith("~"):
                target_dir = os.path.expanduser(target_dir)
            new_path = os.path.abspath(os.path.join(state.cwd, target_dir))
            if os.path.exists(new_path) and os.path.isdir(new_path):
                state.cwd = new_path
                return ToolExecutionResult(
                    status="ok",
                    result_str=tool_ok("bash", {
                        "stdout": f"Changed directory to: {state.cwd}",
                        "stderr": "",
                        "exit_code": 0,
                        "cwd": state.cwd,
                        "shell_backend": state.shell_backend,
                        "shell_executable": state.shell_executable,
                    })
                )
            else:
                return ToolExecutionResult(
                    status="ok",
                    result_str=tool_ok("bash", {
                        "stdout": "",
                        "stderr": f"cd: no such file or directory: {target_dir}",
                        "exit_code": 1,
                        "cwd": state.cwd,
                        "shell_backend": state.shell_backend,
                        "shell_executable": state.shell_executable,
                    })
                )
        return None

    def _build_shell_cmd(self, command: str, state: ShellState) -> list[str]:
        if not state.shell_executable:
            raise RuntimeError(state.shell_error or "Shell executable is not configured.")
        shell_cmd = [state.shell_executable]
        if state.shell_backend == "powershell":
            shell_cmd.extend(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command])
        else:
            shell_cmd.extend(["-c", command])
        return shell_cmd

    def _build_output(self, head: list[str], tail: deque, total_len: int) -> str:
        if total_len <= self.HEAD_LIMIT:
            return "".join(head)
        if total_len <= self.HEAD_LIMIT + self.TAIL_LIMIT:
            return "".join(head) + "".join(tail)
        return "".join(head) + "\n\n...[OUTPUT TRUNCATED]...\n\n" + "".join(tail)

    def _append_chunk(
        self,
        chunk: str,
        head: list[str],
        tail: deque,
        length: list[int],
        updated_event: asyncio.Event | None = None,
    ) -> None:
        clen = len(chunk)
        cur = length[0]
        length[0] += clen
        space = self.HEAD_LIMIT - cur
        if space > 0:
            if clen <= space:
                head.append(chunk)
            else:
                head.append(chunk[:space])
                tail.extend(chunk[space:])
        else:
            tail.extend(chunk)
        if updated_event and chunk:
            updated_event.set()

    async def _read_stream(
        self,
        stream: asyncio.StreamReader,
        head: list[str],
        tail: deque,
        length: list[int],
        updated_event: asyncio.Event | None = None,
    ) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            raw = await stream.read(4096)
            if not raw:
                flushed = decoder.decode(b"", True)
                if flushed:
                    self._append_chunk(flushed, head, tail, length, updated_event)
                break
            self._append_chunk(decoder.decode(raw, False), head, tail, length, updated_event)

    def _clamp_wait_ms(self, wait_ms: int | float | str | None, default: int) -> int:
        try:
            value = int(wait_ms if wait_ms is not None else default)
        except (TypeError, ValueError):
            value = default
        return max(self.MIN_WAIT_MS, min(value, self.MAX_WAIT_MS))

    def _clamp_background_output_wait_ms(self, wait_ms: int | float | str | None) -> int:
        try:
            value = int(wait_ms if wait_ms is not None else self.BACKGROUND_OUTPUT_DEFAULT_WAIT_MS)
        except (TypeError, ValueError):
            value = self.BACKGROUND_OUTPUT_DEFAULT_WAIT_MS
        return max(
            self.BACKGROUND_OUTPUT_MIN_WAIT_MS,
            min(value, self.BACKGROUND_OUTPUT_MAX_WAIT_MS),
        )

    def _clamp_output_chars(self, max_output_chars: int | float | str | None, default: int = 20000) -> int:
        try:
            value = int(max_output_chars if max_output_chars is not None else default)
        except (TypeError, ValueError):
            value = default
        return max(1, min(value, self.MAX_OUTPUT_CHARS))

    def _suggested_next_wait_ms(self, empty_count: int) -> int:
        if empty_count <= 3:
            return 120000
        return 300000

    def _delta_since(self, text: str, cursor: int, max_chars: int) -> tuple[str, int, bool]:
        next_cursor = len(text)
        if cursor < 0 or cursor > len(text):
            cursor = 0
        delta = text[cursor:]
        truncated = len(delta) > max_chars
        if truncated:
            delta = delta[-max_chars:]
        return delta, next_cursor, truncated

    def _full_output(self, bg: _BgProc) -> tuple[str, str]:
        stdout = self._build_output(bg.stdout_head, bg.stdout_tail, bg.stdout_len[0])
        stderr = self._build_output(bg.stderr_head, bg.stderr_tail, bg.stderr_len[0])
        return stdout, stderr

    def _delta_output(self, bg: _BgProc, max_output_chars: int) -> tuple[str, str, bool]:
        stdout, stderr = self._full_output(bg)
        stdout_delta, bg.stdout_cursor, stdout_truncated = self._delta_since(
            stdout, bg.stdout_cursor, max_output_chars
        )
        stderr_delta, bg.stderr_cursor, stderr_truncated = self._delta_since(
            stderr, bg.stderr_cursor, max_output_chars
        )
        return stdout_delta, stderr_delta, stdout_truncated or stderr_truncated

    def _background_payload(
        self,
        bg: _BgProc,
        *,
        stdout: str,
        stderr: str,
        wait_ms: int,
        elapsed_ms: int,
        truncated: bool = False,
        no_new_output: bool = False,
    ) -> dict:
        running = bg.exit_code is None
        if no_new_output and running:
            bg.empty_observation_count += 1
        else:
            bg.empty_observation_count = 0
        bg.sequence += 1
        bg.last_observed_at = time.monotonic()
        return {
            "bg_id": bg.bg_id,
            "status": "running" if running else "done",
            "stdout": stdout.strip(),
            "stderr": stderr.strip(),
            "exit_code": bg.exit_code if bg.exit_code is not None else -1,
            "delta": True,
            "no_new_output": bool(no_new_output),
            "sequence": bg.sequence,
            "wait_ms": wait_ms,
            "elapsed_ms": elapsed_ms,
            "truncated": bool(truncated),
            "empty_observation_count": bg.empty_observation_count,
            "suggested_next_wait_ms": self._suggested_next_wait_ms(bg.empty_observation_count),
        }

    def _completed_bash_payload(self, bg: _BgProc) -> dict:
        stdout, stderr = self._full_output(bg)
        return {
            "stdout": stdout.strip(),
            "stderr": stderr.strip(),
            "exit_code": bg.exit_code if bg.exit_code is not None else -1,
            "cwd": bg.cwd,
            "shell_backend": bg.shell_backend,
            "shell_executable": bg.shell_executable,
        }

    # ------------------------------------------------------------------
    # Foreground execution (existing behaviour)
    # ------------------------------------------------------------------

    async def run(
        self,
        command: str,
        state: ShellState,
        cancellation_token: CancellationToken | None = None,
    ) -> ToolExecutionResult:
        """Run a command and block until it exits or times out."""
        cd_result = self._handle_cd(command, state)
        if cd_result:
            return cd_result

        try:
            shell_cmd = self._build_shell_cmd(command, state)
            process = await asyncio.create_subprocess_exec(
                *shell_cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=state.cwd,
                env=state.env,
            )

            stdout_head: list[str] = []
            stdout_tail: deque = deque(maxlen=self.TAIL_LIMIT)
            stdout_len: list[int] = [0]
            stderr_head: list[str] = []
            stderr_tail: deque = deque(maxlen=self.TAIL_LIMIT)
            stderr_len: list[int] = [0]

            t_out = asyncio.create_task(self._read_stream(process.stdout, stdout_head, stdout_tail, stdout_len))
            t_err = asyncio.create_task(self._read_stream(process.stderr, stderr_head, stderr_tail, stderr_len))

            timeout_msg = ""
            wait_task = asyncio.create_task(process.wait())
            tasks_to_wait = [wait_task, t_out, t_err]

            cancel_task = None
            if cancellation_token:
                cancel_task = asyncio.create_task(cancellation_token.wait())
                tasks_to_wait.append(cancel_task)

            done, pending = await asyncio.wait(
                tasks_to_wait,
                timeout=self.timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )

            if not done:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                timeout_msg = f"\n\n[PROCESS TERMINATED: Command timed out after {self.timeout} seconds.]"
                await process.wait()
            elif cancel_task and cancel_task in done:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                timeout_msg = f"\n\n[PROCESS TERMINATED: Command cancelled: {cancellation_token.reason}]"
                await process.wait()
            else:
                await wait_task
            await asyncio.gather(t_out, t_err, return_exceptions=True)
            await self._settle_tasks(tasks_to_wait)

            stdout_final = self._build_output(stdout_head, stdout_tail, stdout_len[0])
            stderr_final = self._build_output(stderr_head, stderr_tail, stderr_len[0])

            if timeout_msg:
                stderr_final += timeout_msg

            return ToolExecutionResult(
                status="ok",
                result_str=tool_ok("bash", {
                    "stdout": stdout_final.strip(),
                    "stderr": stderr_final.strip(),
                    "exit_code": process.returncode if process.returncode is not None else -1,
                    "cwd": state.cwd,
                    "shell_backend": state.shell_backend,
                    "shell_executable": state.shell_executable,
                }),
                exit_code=process.returncode if process.returncode is not None else -1,
            )

        except Exception as e:
            return ToolExecutionResult(
                status="error",
                error_msg=str(e),
                error_type=type(e).__name__,
            )

    async def _settle_tasks(self, tasks: list[asyncio.Task]) -> None:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------------
    # Background execution
    # ------------------------------------------------------------------

    async def _spawn_background(self, command: str, state: ShellState, session_id: str) -> _BgProc:
        shell_cmd = self._build_shell_cmd(command, state)
        process = await asyncio.create_subprocess_exec(
            *shell_cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=state.cwd,
            env=state.env,
        )

        bg_id = f"bg_{uuid.uuid4().hex[:8]}"
        bg = _BgProc(
            bg_id=bg_id,
            session_id=session_id,
            process=process,
            command=command,
            cwd=state.cwd,
            shell_backend=state.shell_backend,
            shell_executable=state.shell_executable,
        )

        async def _drain():
            tasks: list[asyncio.Task] = []
            try:
                t_out = asyncio.create_task(
                    self._read_stream(
                        process.stdout,
                        bg.stdout_head,
                        bg.stdout_tail,
                        bg.stdout_len,
                        bg.updated_event,
                    )
                )
                t_err = asyncio.create_task(
                    self._read_stream(
                        process.stderr,
                        bg.stderr_head,
                        bg.stderr_tail,
                        bg.stderr_len,
                        bg.updated_event,
                    )
                )
                tasks.extend([t_out, t_err])
                await process.wait()
                await asyncio.gather(t_out, t_err)
                bg.exit_code = process.returncode
            finally:
                await self._settle_tasks(tasks)
                bg.updated_event.set()

        bg._tasks.append(asyncio.create_task(_drain()))
        self._bg[bg_id] = bg
        return bg

    async def run_background_with_initial_wait(
        self,
        command: str,
        state: ShellState,
        session_id: str = "default",
        wait_ms: int = 10000,
        cancellation_token: CancellationToken | None = None,
    ) -> ToolExecutionResult:
        """Spawn a process, wait briefly, and return final output or a bg_id."""
        cd_result = self._handle_cd(command, state)
        if cd_result:
            return cd_result
        wait_ms = self._clamp_wait_ms(wait_ms, 10000)
        started = time.monotonic()
        bg: _BgProc | None = None
        try:
            bg = await self._spawn_background(command, state, session_id)
            cancelled = await self._wait_for_exit_or_cancel_or_deadline(bg, wait_ms, cancellation_token)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            if cancelled:
                await self.kill_background_wait(bg.bg_id)
                return ToolExecutionResult(
                    status="ok",
                    result_str=tool_ok("bash", {
                        "stdout": "",
                        "stderr": f"[PROCESS TERMINATED: Command cancelled: {cancellation_token.reason}]",
                        "exit_code": -1,
                        "cwd": state.cwd,
                        "shell_backend": state.shell_backend,
                        "shell_executable": state.shell_executable,
                        "status": "cancelled",
                    }),
                    exit_code=-1,
                )
            if bg.exit_code is not None:
                self._bg.pop(bg.bg_id, None)
                return ToolExecutionResult(
                    status="ok",
                    result_str=tool_ok("bash", self._completed_bash_payload(bg)),
                    exit_code=bg.exit_code,
                )
            stdout, stderr, truncated = self._delta_output(bg, self._clamp_output_chars(20000))
            payload = self._background_payload(
                bg,
                stdout=stdout,
                stderr=stderr,
                wait_ms=wait_ms,
                elapsed_ms=elapsed_ms,
                truncated=truncated,
                no_new_output=not stdout and not stderr,
            )
            payload.update(
                {
                    "message": f"Background process started: {command[:200]}",
                    "cwd": state.cwd,
                    "shell_backend": state.shell_backend,
                    "shell_executable": state.shell_executable,
                }
            )
            return ToolExecutionResult(status="ok", result_str=tool_ok("bash", payload))
        except asyncio.CancelledError:
            if bg is not None:
                await self.kill_background_wait(bg.bg_id)
            raise
        except Exception as e:
            return ToolExecutionResult(
                status="error",
                error_msg=str(e),
                error_type=type(e).__name__,
            )

    async def _wait_for_update_or_exit(self, bg: _BgProc, wait_ms: int) -> None:
        if bg.exit_code is not None:
            return
        try:
            await asyncio.wait_for(bg.updated_event.wait(), timeout=wait_ms / 1000)
        except asyncio.TimeoutError:
            return
        finally:
            bg.updated_event.clear()

    async def _wait_for_update_or_exit_or_cancel(
        self,
        bg: _BgProc,
        wait_ms: int,
        cancellation_token: CancellationToken | None,
    ) -> bool:
        if not cancellation_token:
            await self._wait_for_update_or_exit(bg, wait_ms)
            return False
        if cancellation_token.is_cancelled:
            return True

        update_task = asyncio.create_task(bg.updated_event.wait())
        cancel_task = asyncio.create_task(cancellation_token.wait())
        try:
            done, _ = await asyncio.wait(
                [update_task, cancel_task],
                timeout=wait_ms / 1000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            return cancel_task in done or cancellation_token.is_cancelled
        finally:
            bg.updated_event.clear()
            for task in (update_task, cancel_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(update_task, cancel_task, return_exceptions=True)

    async def _wait_for_exit_or_deadline(self, bg: _BgProc, wait_ms: int) -> None:
        if bg.exit_code is not None:
            return
        deadline = time.monotonic() + (wait_ms / 1000)
        while bg.exit_code is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                await asyncio.wait_for(bg.updated_event.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return
            finally:
                bg.updated_event.clear()

    async def _wait_for_exit_or_cancel_or_deadline(
        self,
        bg: _BgProc,
        wait_ms: int,
        cancellation_token: CancellationToken | None,
    ) -> bool:
        if not cancellation_token:
            await self._wait_for_exit_or_deadline(bg, wait_ms)
            return False
        if cancellation_token.is_cancelled:
            return True

        deadline = time.monotonic() + (wait_ms / 1000)
        cancel_task = asyncio.create_task(cancellation_token.wait())
        try:
            while bg.exit_code is None:
                if cancellation_token.is_cancelled:
                    return True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                update_task = asyncio.create_task(bg.updated_event.wait())
                try:
                    done, _ = await asyncio.wait(
                        [update_task, cancel_task],
                        timeout=remaining,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if cancel_task in done:
                        return True
                    if not done:
                        return False
                finally:
                    bg.updated_event.clear()
                    if not update_task.done():
                        update_task.cancel()
                    await asyncio.gather(update_task, return_exceptions=True)
        finally:
            if not cancel_task.done():
                cancel_task.cancel()
            await asyncio.gather(cancel_task, return_exceptions=True)
        return False

    async def read_background_wait(
        self,
        bg_id: str,
        wait_ms: int = 15000,
        max_output_chars: int = 20000,
        cancellation_token: CancellationToken | None = None,
    ) -> ToolExecutionResult:
        """Wait for new output from a background process and return a delta."""
        bg = self._bg.get(bg_id)
        if not bg:
            return ToolExecutionResult(status="error", error_msg=f"No background process: {bg_id}", error_type="NotFound")

        wait_ms = self._clamp_background_output_wait_ms(wait_ms)
        max_output_chars = self._clamp_output_chars(max_output_chars)
        started = time.monotonic()
        stdout, stderr, truncated = self._delta_output(bg, max_output_chars)
        if not stdout and not stderr and bg.exit_code is None:
            cancelled = await self._wait_for_update_or_exit_or_cancel(bg, wait_ms, cancellation_token)
            if cancelled:
                reason = cancellation_token.reason if cancellation_token else "cancelled"
                return ToolExecutionResult(
                    status="ok",
                    result_str=tool_cancelled("bash_output", reason),
                    exit_code=-1,
                )
            stdout, stderr, truncated = self._delta_output(bg, max_output_chars)

        elapsed_ms = int((time.monotonic() - started) * 1000)
        no_new_output = not stdout and not stderr and bg.exit_code is None
        payload = self._background_payload(
            bg,
            stdout=stdout,
            stderr=stderr,
            wait_ms=wait_ms,
            elapsed_ms=elapsed_ms,
            truncated=truncated,
            no_new_output=no_new_output,
        )
        if bg.exit_code is not None:
            self._bg.pop(bg_id, None)

        return ToolExecutionResult(
            status="ok",
            result_str=tool_ok("bash_output", payload),
            exit_code=bg.exit_code if bg.exit_code is not None else -1,
        )

    def kill_background(self, bg_id: str) -> ToolExecutionResult:
        """Kill a background process and remove it from the registry."""
        bg = self._bg.pop(bg_id, None)
        if not bg:
            return ToolExecutionResult(status="error", error_msg=f"No background process: {bg_id}", error_type="NotFound")

        for t in bg._tasks:
            t.cancel()
        try:
            bg.process.kill()
        except ProcessLookupError:
            pass

        return ToolExecutionResult(
            status="ok",
            result_str=tool_ok("bash_output", {"bg_id": bg_id, "status": "killed", "exit_code": None}),
        )

    async def kill_background_wait(self, bg_id: str) -> ToolExecutionResult:
        """Kill a background process and wait briefly for transports to close."""
        bg = self._bg.pop(bg_id, None)
        if not bg:
            return ToolExecutionResult(status="error", error_msg=f"No background process: {bg_id}", error_type="NotFound")

        try:
            if bg.process.returncode is None:
                try:
                    bg.process.kill()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(bg.process.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass

            if bg._tasks:
                _, pending = await asyncio.wait(bg._tasks, timeout=2)
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
        finally:
            bg.updated_event.set()

        return ToolExecutionResult(
            status="ok",
            result_str=tool_ok("bash_output", {"bg_id": bg_id, "status": "killed", "exit_code": None}),
        )

    def kill_session_backgrounds(self, session_id: str) -> None:
        """Kill all background processes belonging to a session."""
        to_kill = [bid for bid, bg in self._bg.items() if bg.session_id == session_id]
        for bid in to_kill:
            self.kill_background(bid)
