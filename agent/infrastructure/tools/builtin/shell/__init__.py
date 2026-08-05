"""Shell tool registration."""

from ...spec import ToolSpec
from .tool import bash, bash_output


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="bash",
        handler=bash,
        description="执行 Shell 命令。支持 cd 保持目录状态，并返回 running、completed、failed、cancelled 或 timed_out 状态。run_in_background=false 时前台运行直到完成或超时；run_in_background=true 时先等待 wait_ms，短任务直接返回结果，仍在运行才返回 bg_id 供 bash_output 后续等待。",
        param_descriptions={
            "command": "要执行的命令",
            "run_in_background": "允许命令在等待窗口后挂起为后台任务。默认 False。",
            "wait_ms": "仅在 run_in_background=true 时生效：后台启动后先等待新输出或完成的毫秒数，默认 10000，范围 1000-60000。前台执行会忽略此参数。",
        },
    ),
    ToolSpec(
        name="bash_output",
        handler=bash_output,
        description="阻塞等待并读取后台进程的增量输出，或终止整个进程树。后台进程运行时始终等待到进程完成或 wait_ms 到期，再一次性返回等待期间累积的输出；no_new_output=true 表示本次没有可返回的新信息，应按 suggested_next_wait_ms 再查。若返回 RepeatedEmptyPoll，应停止继续轮询并把 bg_id 告诉用户，提示稍后可继续查看。",
        param_descriptions={
            "bg_id": "后台进程 ID（bash 返回的 bg_id）",
            "kill": "设为 true 可终止该进程。默认 False（仅读取输出）。",
            "wait_ms": "阻塞等待新输出或完成的最长毫秒数，默认 15000，范围 5000-300000。连续无输出时建议等待 120000 或 300000。",
            "max_output_chars": "单次返回 stdout/stderr 增量的最大字符数，默认 20000，最大 40000。",
        },
    ),
)


__all__ = ["TOOL_SPECS", "bash", "bash_output"]
