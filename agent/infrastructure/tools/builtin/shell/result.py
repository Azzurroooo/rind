from __future__ import annotations

from agent.domain import tool_ok
from agent.domain.tool_result import ToolExecutionResult

from .process import ProcessRecord
from .session_pool import ShellState


def cd_result(state: ShellState, message: str, exit_code: int) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="ok",
        result_str=tool_ok(
            "bash",
            {
                "status": "completed" if exit_code == 0 else "failed",
                "stdout": message if exit_code == 0 else "",
                "stderr": message if exit_code else "",
                "exit_code": exit_code,
                "cwd": state.cwd,
                "shell_backend": state.shell_backend,
                "shell_executable": state.shell_executable,
            },
        ),
        exit_code=exit_code,
    )


def completed_result(
    tool: str,
    record: ProcessRecord,
    timeout: int,
    cancellation_reason: str | None = None,
) -> ToolExecutionResult:
    stdout = record.stdout.render().strip()
    stderr = record.stderr.render().strip()
    if record.status == "cancelled":
        message = "Command cancelled"
        if cancellation_reason:
            message += f": {cancellation_reason}"
        stderr = _append_message(stderr, message)
    elif record.status == "timed_out":
        stderr = _append_message(stderr, f"Command timed out after {timeout} seconds.")
    return ToolExecutionResult(
        status="ok",
        result_str=tool_ok(
            tool,
            {
                "status": record.status,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": display_exit_code(record),
                "cwd": record.cwd,
                "shell_backend": record.shell_backend,
                "shell_executable": record.shell_executable,
            },
            meta=output_meta(record),
        ),
        exit_code=display_exit_code(record),
    )


def cancelled_result(tool: str, record: ProcessRecord) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="ok",
        result_str=tool_ok(
            tool,
            {
                "bg_id": record.process_id,
                "status": "cancelled",
                "stdout": record.stdout.render().strip(),
                "stderr": record.stderr.render().strip(),
                "exit_code": -1,
            },
            meta=output_meta(record),
        ),
        exit_code=-1,
    )


def background_payload(
    record: ProcessRecord,
    stdout: str,
    stderr: str,
    wait_ms: int,
    elapsed_ms: int,
    no_new_output: bool,
) -> dict:
    if no_new_output and record.status == "running":
        record.empty_observation_count += 1
    else:
        record.empty_observation_count = 0
    record.sequence += 1
    return {
        "bg_id": record.process_id,
        "status": record.status,
        "stdout": stdout.strip(),
        "stderr": stderr.strip(),
        "exit_code": display_exit_code(record),
        "delta": True,
        "no_new_output": no_new_output,
        "sequence": record.sequence,
        "wait_ms": wait_ms,
        "elapsed_ms": elapsed_ms,
        "empty_observation_count": record.empty_observation_count,
        "suggested_next_wait_ms": (
            120000 if record.empty_observation_count <= 3 else 300000
        ),
    }


def delta_output(record: ProcessRecord, max_chars: int) -> tuple[str, str, bool]:
    stdout, record.stdout_cursor, stdout_truncated = record.stdout.delta(
        record.stdout_cursor, max_chars
    )
    stderr, record.stderr_cursor, stderr_truncated = record.stderr.delta(
        record.stderr_cursor, max_chars
    )
    return stdout, stderr, stdout_truncated or stderr_truncated


def output_meta(record: ProcessRecord, preview_truncated: bool = False) -> dict:
    return {
        "truncated": record.stdout.truncated
        or record.stderr.truncated
        or preview_truncated,
        "total_bytes": record.stdout.byte_count + record.stderr.byte_count,
        "total_lines": record.stdout.line_count + record.stderr.line_count,
    }


def display_exit_code(record: ProcessRecord) -> int:
    if record.status in {"cancelled", "timed_out"}:
        return -1
    return record.exit_code if record.exit_code is not None else -1


def not_found(process_id: str) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="error",
        error_msg=f"No background process: {process_id}",
        error_type="NotFound",
    )


def error_result(exc: Exception) -> ToolExecutionResult:
    return ToolExecutionResult(
        status="error", error_msg=str(exc), error_type=type(exc).__name__
    )


def _append_message(stderr: str, message: str) -> str:
    return f"{stderr}\n\n[PROCESS TERMINATED: {message}]".strip()
