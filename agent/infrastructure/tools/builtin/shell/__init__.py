"""Shell tool registration."""

from __future__ import annotations

from agent.domain.cancellation import CancellationToken

from ...spec import ToolSpec
from .tool import bash, bash_output


def build_shell_tool_specs(workspace_root: str | None = None, output_store=None) -> tuple[ToolSpec, ...]:
    if workspace_root is None:
        return TOOL_SPECS

    async def scoped_bash(
        command: str,
        run_in_background: bool = False,
        wait_ms: int = 10000,
        _session_id: str = "default",
        _cancellation_token: CancellationToken | None = None,
        _idempotency_key: str = "",
        _output_store=None,
    ) -> str:
        return await bash(
            command,
            run_in_background,
            wait_ms,
            _session_id,
            _cancellation_token,
            workspace_root,
            _idempotency_key,
            _output_store or output_store,
        )

    return _specs(scoped_bash, bash_output)


def _specs(bash_handler, bash_output_handler) -> tuple[ToolSpec, ...]:
    return (
        ToolSpec(
            name="bash",
            handler=bash_handler,
            description="执行 Shell 命令。每次调用从当前项目工作目录启动；cd 只在本次命令内生效，如需切换目录后继续执行请使用 cd <dir> && <command>。返回 running、completed、failed、cancelled 或 timed_out 状态。run_in_background=false 时前台运行直到完成或超时；run_in_background=true 时先等待 wait_ms，短任务直接返回结果，仍在运行才返回 bg_id 供 bash_output 后续等待。",
            param_descriptions={
                "command": "要执行的命令",
                "run_in_background": "允许命令在等待窗口后挂起为后台任务。默认 False。",
                "wait_ms": "仅在 run_in_background=true 时生效：后台启动后先等待新输出或完成的毫秒数，默认 10000，范围 1000-60000。前台执行会忽略此参数。",
            },
        ),
        ToolSpec(
            name="bash_output",
            handler=bash_output_handler,
            description="阻塞等待并读取后台进程的增量输出，或终止整个进程树。后台进程运行时始终等待到进程完成或 wait_ms 到期，再一次性返回等待期间累积的输出；no_new_output=true 表示本次没有可返回的新信息，应按 suggested_next_wait_ms 再查。若返回 RepeatedEmptyPoll，应停止继续轮询并把 bg_id 告诉用户，提示稍后可继续查看。",
            param_descriptions={
                "bg_id": "后台进程 ID（bash 返回的 bg_id）。",
                "kill": "设为 true 可终止该进程。默认 False（仅读取输出）。",
                "wait_ms": "阻塞等待新输出或完成的最长毫秒数，默认 15000，范围 5000-300000。连续无输出时建议等待 120000 或 300000。",
                "max_output_chars": "单次返回 stdout/stderr 增量的最大字符数，默认 20000，最大 40000。",
            },
        ),
    )


TOOL_SPECS = _specs(bash, bash_output)


__all__ = ["TOOL_SPECS", "bash", "bash_output", "build_shell_tool_specs"]
