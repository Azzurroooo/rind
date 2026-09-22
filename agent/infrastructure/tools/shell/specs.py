"""Shell tools and the narrow legacy invocation boundary."""
from __future__ import annotations

from agent.domain.cancellation import CancellationToken
from agent.infrastructure.tools.spec import ToolSpec
from agent.infrastructure.tools.shell.tool import ShellTools, integer


def normalize_bash_arguments(args: dict) -> dict:
    if "run_in_background" in args or "wait_ms" in args:
        if any(key in args for key in ("yield_time_ms", "timeout_ms", "notify", "cwd")):
            raise ValueError("Do not combine legacy run_in_background/wait_ms with new bash parameters.")
        background = args.pop("run_in_background", False)
        if type(background) is not bool:
            raise ValueError("run_in_background must be boolean.")
        wait = args.pop("wait_ms", 10000)
        args["yield_time_ms"] = max(0, min(integer(wait, "wait_ms", 0), 60000)) if background else 10000
    return args


def build_shell_tool_specs(shell_tools: ShellTools, workspace_root: str | None = None) -> tuple[ToolSpec, ...]:
    async def scoped_bash(command: str, cwd: str | None = None, yield_time_ms: int = 10000,
                          timeout_ms: int | None = None, notify: str = "on_exit",
                          _session_id: str = "default", _cancellation_token: CancellationToken | None = None,
                          _idempotency_key: str = "", _output_store=None,
                          _origin_turn_id: str = "", _request_id: str | None = None) -> str:
        return await shell_tools.bash(command, cwd, yield_time_ms, timeout_ms, notify,
            _session_id=_session_id, _cancellation_token=_cancellation_token,
            _workspace_root=workspace_root, _idempotency_key=_idempotency_key, _output_store=_output_store,
            _origin_turn_id=_origin_turn_id, _request_id=_request_id)

    return (
        ToolSpec(name="bash", handler=scoped_bash, normalize_arguments=normalize_bash_arguments,
            description="Run a managed non-interactive shell command. After yield_time_ms the same process continues under its task_id. timeout_ms is a separate optional runtime deadline. cwd applies only to this command. Use task_control to inspect or cancel tasks; interactive stdin and detached daemons are unsupported.",
            param_descriptions={"yield_time_ms": {"minimum": 0, "maximum": 60000},
                "timeout_ms": {"type": ["integer", "null"], "minimum": 1}, "notify": {"enum": ["on_exit", "manual"]}}),
        ToolSpec(name="task_control", handler=shell_tools.task_control,
            description="Control a task owned by this session. list returns up to 50 tasks; read returns immediately; wait observes completion for a bounded interval without killing the task; cancel explicitly terminates its process tree. Reads are repeatable; use next_cursor for sequential output. No interactive stdin.",
            param_descriptions={"action": {"enum": ["list", "read", "wait", "cancel"]}}),
        ToolSpec(name="bash_output", handler=shell_tools.bash_output, advertised=False,
            description="Legacy recovery only: kill maps to cancel, otherwise wait. Unknown old bg_id values cannot be restarted."),
    )
