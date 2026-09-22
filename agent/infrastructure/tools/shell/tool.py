from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from agent.domain import tool_error
from agent.domain.cancellation import CancellationToken
from agent.infrastructure.persistence import ToolOutputStore
from agent.infrastructure.tools.shell.session_pool import ShellSessionPool
from agent.infrastructure.tools.shell.policy import BashPolicy
from agent.infrastructure.tools.shell.supervisor import ProcessSupervisor


def integer(value, name: str, minimum: int, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f"{name} must be an integer in {minimum}..{maximum if maximum is not None else 'unlimited'}.")
    return value


def unwrap(result, tool: str) -> str:
    return result.result_str if result.status == "ok" else tool_error(tool, result.error_msg, result.error_type)


class ShellTools:
    def __init__(self, output_store: ToolOutputStore):
        self.pool = ShellSessionPool()
        self.supervisor = ProcessSupervisor()
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

    async def bash(self, command: str, cwd: str | None = None, yield_time_ms: int = 10000,
                   timeout_ms: int | None = None, notify: str = "on_exit", *,
                   _session_id: str = "default", _cancellation_token: CancellationToken | None = None,
                   _workspace_root: str | None = None, _idempotency_key: str = "", _output_store=None) -> str:
        try:
            if not isinstance(command, str) or not command.strip():
                raise ValueError("command must be a nonempty string.")
            integer(yield_time_ms, "yield_time_ms", 0, 60000)
            if timeout_ms is not None:
                integer(timeout_ms, "timeout_ms", 1)
            if notify not in ("on_exit", "manual"):
                raise ValueError("notify must be on_exit or manual.")
            state = self.pool.get_state(_session_id, workspace_root=_workspace_root)
            if cwd is not None:
                if not isinstance(cwd, str) or not cwd.strip():
                    raise ValueError("cwd must be a nonempty path.")
                target = (Path(state.cwd) / cwd).resolve()
                if not target.is_dir():
                    raise ValueError("cwd must be an existing directory.")
                state = replace(state, cwd=str(target))
        except (ValueError, TypeError) as exc:
            return tool_error("bash", str(exc), "InvalidArguments")
        status, reason = BashPolicy.classify(command, state.shell_backend)
        if status == "deny":
            return tool_error("bash", f"Blocked forbidden command. {reason}", "DangerousCommandBlocked")
        return unwrap(await self.supervisor.run(command, state, _session_id, _cancellation_token,
            call_id=_idempotency_key, output_store=_output_store or self.output_store,
            yield_time_ms=yield_time_ms, timeout_ms=timeout_ms, notify=notify), "bash")

    async def task_control(self, action: str, task_id: str | None = None, cursor: str | None = None,
                           wait_ms: int | None = None, max_output_chars: int = 20000,
                           page_token: str | None = None, *, _session_id: str = "default",
                           _cancellation_token: CancellationToken | None = None) -> str:
        try:
            if action not in ("list", "read", "wait", "cancel"):
                raise ValueError("action must be list, read, wait or cancel.")
            integer(max_output_chars, "max_output_chars", 1, 50000)
            if action == "list":
                if any(value is not None for value in (task_id, cursor, wait_ms)):
                    raise ValueError("list does not accept task_id, cursor or wait_ms.")
                if page_token is not None and (not isinstance(page_token, str) or not page_token.isdecimal()):
                    raise ValueError("Invalid page_token.")
            else:
                if not isinstance(task_id, str) or not task_id:
                    raise ValueError("task_id is required.")
                if page_token is not None:
                    raise ValueError("page_token is only valid for list.")
                if action != "wait" and wait_ms is not None:
                    raise ValueError("wait_ms is only valid for wait.")
                if action == "cancel" and cursor is not None:
                    raise ValueError("cancel does not accept cursor.")
            if wait_ms is not None:
                integer(wait_ms, "wait_ms", 1000, 60000)
            result = await self.supervisor.control(action, _session_id, task_id,
                wait_ms=30000 if wait_ms is None else wait_ms, max_output_chars=max_output_chars,
                cancellation_token=_cancellation_token, page_token=page_token)
            return unwrap(result, "task_control")
        except (ValueError, TypeError) as exc:
            return tool_error("task_control", str(exc), "InvalidArguments")

    async def bash_output(self, bg_id: str, kill: bool = False, wait_ms: int = 15000,
                          max_output_chars: int = 20000, _session_id: str = "default",
                          _cancellation_token: CancellationToken | None = None) -> str:
        if type(kill) is not bool:
            return tool_error("bash_output", "kill must be boolean.", "InvalidArguments")
        result = json.loads(await self.task_control("cancel" if kill else "wait", bg_id,
            wait_ms=None if kill else max(1000, min(integer(wait_ms, "wait_ms", 0), 60000)),
            max_output_chars=max_output_chars, _session_id=_session_id, _cancellation_token=_cancellation_token))
        result["tool"] = "bash_output"
        return json.dumps(result, ensure_ascii=False)

    async def list_backgrounds(self, _session_id: str = "default") -> list[dict]:
        payload = json.loads(await self.task_control("list", _session_id=_session_id))
        return [{**task, "bg_id": task["task_id"]} for task in payload["data"]["tasks"]]

    async def snapshot_background(self, bg_id: str, max_output_chars: int = 20000, _session_id: str = "default") -> dict:
        payload = json.loads(await self.task_control("read", bg_id, max_output_chars=max_output_chars, _session_id=_session_id))
        if not payload["ok"]:
            raise LookupError(payload["error"])
        return {**payload["data"], **payload.get("meta", {}), "bg_id": bg_id}
