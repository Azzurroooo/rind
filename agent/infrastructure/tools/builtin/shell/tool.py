from __future__ import annotations

import atexit

from agent.domain import tool_error, tool_ok
from agent.domain.cancellation import CancellationToken
from .session_pool import ShellSessionPool
from .policy import BashPolicy
from .supervisor import ProcessSupervisor

_POOL = ShellSessionPool()
_SUPERVISOR = ProcessSupervisor(timeout=120)
atexit.register(_SUPERVISOR.close_now)


async def bash(
    command: str,
    run_in_background: bool = False,
    wait_ms: int = 10000,
    _session_id: str = "default",
    _cancellation_token: CancellationToken | None = None,
) -> str:
    """Execute a bash command. Use run_in_background=true for long-running commands like servers."""
    status, reason = BashPolicy.classify(command)

    if status == "deny":
        return tool_error(
            "bash",
            f"Blocked forbidden command. {reason}",
            "DangerousCommandBlocked",
            meta={"command": command[:500]},
        )

    if status == "needs_approval":
        return tool_error(
            "bash",
            f"Potentially dangerous command requires user approval: {reason}",
            "CommandRequiresApproval",
            meta={"command": command[:500]},
        )

    state = _POOL.get_state(_session_id)

    if run_in_background:
        result = await _SUPERVISOR.run_background(
            command,
            state,
            session_id=_session_id,
            wait_ms=wait_ms,
            cancellation_token=_cancellation_token,
        )
    else:
        result = await _SUPERVISOR.run(
            command,
            state,
            session_id=_session_id,
            cancellation_token=_cancellation_token,
        )

    if result.status == "ok":
        return result.result_str
    else:
        return tool_error("bash", result.error_msg, result.error_type)


async def bash_output(
    bg_id: str,
    kill: bool = False,
    wait_ms: int = 15000,
    max_output_chars: int = 20000,
    _session_id: str = "default",
    _cancellation_token: CancellationToken | None = None,
) -> str:
    """
    Read output from a background process, or terminate it.
    :param bg_id: Background process ID returned by bash(run_in_background=true)
    :param kill: Set to true to terminate the process (default false = read only)
    :param wait_ms: Time to wait for new output/completion before returning
    :param max_output_chars: Maximum chars returned per stdout/stderr delta
    """
    if kill:
        result = await _SUPERVISOR.cancel_background(bg_id, _session_id)
    else:
        result = await _SUPERVISOR.read_background(
            bg_id,
            _session_id,
            wait_ms=wait_ms,
            max_output_chars=max_output_chars,
            cancellation_token=_cancellation_token,
        )

    if result.status == "ok":
        return result.result_str
    else:
        return tool_error("bash_output", result.error_msg, result.error_type)
