from __future__ import annotations

import time

from agent.domain import tool_ok
from agent.domain.tool_result import ToolExecutionResult
from agent.infrastructure.tools.shell.process import ProcessRecord


def task_snapshot(record: ProcessRecord) -> dict:
    return {
        "task_id": record.task_id,
        "owner_session_id": record.session_id,
        "origin_tool_call_id": record.call_id,
        "command": record.command,
        "cwd": record.cwd,
        "shell_backend": record.shell_backend,
        "shell_executable": record.shell_executable,
        "status": record.status,
        "exit_code": record.exit_code,
        "notify": record.notify,
        "started_at": record.started_at,
        "finished_at": record.finished_at,
        "elapsed_ms": max(0, int(((record.finished_at or time.time()) - record.started_at) * 1000)),
        "reason": record.reason,
    }


def task_result(tool: str, record: ProcessRecord, return_reason: str, max_chars: int = 20000) -> ToolExecutionResult:
    stdout = record.stdout.render()
    stderr = record.stderr.render()
    truncated = record.stdout.truncated or record.stderr.truncated or len(stdout) + len(stderr) > max_chars
    stderr = stderr[-min(len(stderr), max_chars // 2):] if stderr else ""
    stdout = stdout[-(max_chars - len(stderr)):] if stdout else ""
    meta = {
        "truncated": truncated,
        "total_bytes": record.stdout.byte_count + record.stderr.byte_count,
        "total_lines": record.stdout.line_count + record.stderr.line_count,
    }
    if record.output_path:
        meta["output_path"] = record.output_path
    return ToolExecutionResult(status="ok", result_str=tool_ok(tool, {
        **task_snapshot(record), "return_reason": return_reason, "stdout": stdout, "stderr": stderr,
    }, meta=meta))


def not_found(task_id: str) -> ToolExecutionResult:
    return ToolExecutionResult(status="error", error_type="NotFound",
        error_msg=f"Task {task_id} is no longer managed by this Worker (or belongs to another session). The command will not be restarted.")


def error_result(exc: Exception) -> ToolExecutionResult:
    return ToolExecutionResult(status="error", error_msg=str(exc), error_type=type(exc).__name__)
