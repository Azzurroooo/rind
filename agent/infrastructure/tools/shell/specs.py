"""Shell tool registration."""

from __future__ import annotations

from agent.domain.cancellation import CancellationToken

from agent.infrastructure.tools.spec import ToolSpec
from agent.infrastructure.tools.shell.tool import ShellTools


def build_shell_tool_specs(shell_tools: ShellTools, workspace_root: str | None = None) -> tuple[ToolSpec, ...]:
    async def scoped_bash(
        command: str,
        run_in_background: bool = False,
        wait_ms: int = 10000,
        _session_id: str = "default",
        _cancellation_token: CancellationToken | None = None,
        _idempotency_key: str = "",
        _output_store=None,
    ) -> str:
        return await shell_tools.bash(
            command,
            run_in_background,
            wait_ms,
            _session_id,
            _cancellation_token,
            workspace_root,
            _idempotency_key,
            _output_store,
        )

    return _specs(scoped_bash, shell_tools.bash_output)


def _specs(bash_handler, bash_output_handler) -> tuple[ToolSpec, ...]:
    return (
        ToolSpec(
            name="bash",
            handler=bash_handler,
            description="Run a shell command. Each call starts in the current project working directory; cd only applies within that command — use `cd <dir> && <command>` to run in another directory. Returns running, completed, failed, cancelled, or timed_out. With run_in_background=false the command runs in the foreground until completion or timeout; with run_in_background=true it first waits wait_ms, returns the result directly for short tasks, and only returns a bg_id for later bash_output polling while still running.",
            param_descriptions={
                "command": "The command to execute",
                "run_in_background": "Allow the command to remain a background task after the wait window. Default False.",
                "wait_ms": "Only effective with run_in_background=true: milliseconds to wait for new output or completion after background start, default 10000, range 1000-60000. Ignored by foreground execution.",
            },
        ),
        ToolSpec(
            name="bash_output",
            handler=bash_output_handler,
            description="Block on and read incremental output of a background process, or kill the whole process tree. While the process runs, always wait until it completes or wait_ms expires, then return the output accumulated during the wait; no_new_output=true means there is nothing new to return and you should poll again after suggested_next_wait_ms. If it returns RepeatedEmptyPoll, stop polling and tell the user the bg_id so they can check again later.",
            param_descriptions={
                "bg_id": "Background process ID (the bg_id returned by bash).",
                "kill": "Set to true to terminate the process. Default False (read output only).",
                "wait_ms": "Maximum milliseconds to block waiting for new output or completion, default 15000, range 5000-300000. When output is silent, waiting 120000 or 300000 is recommended.",
                "max_output_chars": "Maximum characters of stdout/stderr delta returned per call, default 20000, maximum 40000.",
            },
        ),
    )


__all__ = ["ShellTools", "build_shell_tool_specs"]
