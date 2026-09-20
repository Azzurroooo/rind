from __future__ import annotations

from agent.domain import tool_error
from agent.domain.cancellation import CancellationToken
from agent.infrastructure.persistence import ToolOutputStore
from .session_pool import ShellSessionPool
from .policy import BashPolicy
from .supervisor import ProcessSupervisor

class ShellTools:
    def __init__(self, output_store: ToolOutputStore):
        self.pool = ShellSessionPool()
        self.supervisor = ProcessSupervisor(timeout=120)
        self.output_store = output_store

    async def close_session(self, session_id: str) -> None:
        await self.supervisor.close_session(session_id)
        self.pool.close(session_id)

    async def close(self) -> None:
        await self.supervisor.close()
        self.pool.clear()

    def close_now(self) -> None:
        self.supervisor.close_now()
        self.pool.clear()

    async def bash(
        self,
        command: str,
        run_in_background: bool = False,
        wait_ms: int = 10000,
        _session_id: str = "default",
        _cancellation_token: CancellationToken | None = None,
        _workspace_root: str | None = None,
        _idempotency_key: str = "",
        _output_store: ToolOutputStore | None = None,
    ) -> str:
        """Execute a bash command. Use run_in_background=true for long-running commands like servers."""
        state = self.pool.get_state(_session_id, workspace_root=_workspace_root)
        status, reason = BashPolicy.classify(command, state.shell_backend)

        if status == "deny":
            return tool_error(
                "bash",
                f"Blocked forbidden command. {reason}",
                "DangerousCommandBlocked",
                meta={"command": command[:500]},
            )

        output_store = _output_store or self.output_store

        if run_in_background:
            result = await self.supervisor.run_background(
                command,
                state,
                session_id=_session_id,
                call_id=_idempotency_key,
                output_store=output_store,
                wait_ms=wait_ms,
                cancellation_token=_cancellation_token,
            )
        else:
            result = await self.supervisor.run(
                command,
                state,
                session_id=_session_id,
                call_id=_idempotency_key,
                output_store=output_store,
                cancellation_token=_cancellation_token,
            )

        if result.status == "ok":
            return result.result_str
        else:
            return tool_error("bash", result.error_msg, result.error_type)


    async def bash_output(
        self,
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
        :param wait_ms: Time to wait for completion or timeout before returning accumulated output
        :param max_output_chars: Maximum chars returned per stdout/stderr delta
        """
        if kill:
            result = await self.supervisor.cancel_background(bg_id, _session_id)
        else:
            result = await self.supervisor.read_background(
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


    async def list_backgrounds(self, _session_id: str = "default") -> list[dict[str, object]]:
        return await self.supervisor.list_backgrounds(_session_id)


    async def snapshot_background(
        self,
        bg_id: str,
        max_output_chars: int = 20000,
        _session_id: str = "default",
    ) -> dict[str, object]:
        snapshot = await self.supervisor.snapshot_background(
            bg_id,
            _session_id,
            max_output_chars=max_output_chars,
        )
        if snapshot is None:
            raise LookupError(f"No background process: {bg_id}")
        return snapshot
