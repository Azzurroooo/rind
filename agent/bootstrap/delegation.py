"""Synchronous Team Capsule delegation without a Team control plane."""

from __future__ import annotations

import json
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from agent.domain import AssistantMessageCompletedEvent, TurnCancelledEvent, TurnFailedEvent, tool_cancelled, tool_error, tool_ok
from agent.domain.cancellation import CancellationToken
from agent.infrastructure.team import TeamProject, WorkspaceBusyError, WorkspaceLock, resolve_team_agent
from agent.infrastructure.planning.store import preserve_active_session_context
from agent.prompts import build_delegate_execute_prompt, build_delegate_inspect_prompt


_MAX_SUMMARY_CHARS = 4_000


class TeamDelegator:
    """Run one target Capsule and return its compact result to the parent tool call."""

    def __init__(
        self,
        *,
        project: TeamProject,
        parent_session,
        settings,
        provider_client_factory,
        session_dir: str | None,
        container_builder: Callable[..., Any] | None = None,
    ) -> None:
        self._project = project
        self._parent_session = parent_session
        self._settings = settings
        self._provider_client_factory = provider_client_factory
        self._session_dir = session_dir
        self._container_builder = container_builder

    async def delegate(
        self,
        agent_id: str,
        task: str,
        mode: str = "execute",
        cancellation_token: CancellationToken | None = None,
    ) -> str:
        normalized_task = str(task or "").strip()
        normalized_mode = str(mode or "").strip().lower() or "execute"
        if not normalized_task:
            return tool_error("delegate", "task is required.", "ValidationError")
        if normalized_mode not in {"execute", "inspect"}:
            return tool_error("delegate", "mode must be 'execute' or 'inspect'.", "ValidationError")
        if cancellation_token and cancellation_token.is_cancelled:
            return tool_cancelled("delegate", cancellation_token.reason)
        try:
            target = resolve_team_agent(self._project, agent_id)
        except ValueError as exc:
            return tool_error("delegate", str(exc), "InvalidAgent", meta={"agent_id": str(agent_id or "")})
        if target.agent_id == self._project.main_agent:
            return tool_error("delegate", "The main Agent cannot delegate to itself.", "InvalidAgent")
        parent_session_id = getattr(self._parent_session, "session_id", None)
        if not isinstance(parent_session_id, str) or not parent_session_id:
            return tool_error("delegate", "Parent Session is unavailable.", "SessionUnavailable")

        try:
            async with WorkspaceLock(self._project.project_id, target.agent_id):
                if normalized_mode == "inspect":
                    return await self._run_inspect(target, normalized_task, cancellation_token)
                return await self._run_execute(target, normalized_task, parent_session_id, cancellation_token)
        except WorkspaceBusyError as exc:
            return tool_error("delegate", str(exc), "WorkspaceBusy", meta={"agent_id": target.agent_id})

    async def _run_execute(self, target, task: str, parent_session_id: str, cancellation_token: CancellationToken | None) -> str:
        with preserve_active_session_context():
            container = self._build_container(
                workspace_root=str(target.workspace_root),
                session_dir=self._session_dir,
                project_id=self._project.project_id,
                owner_agent_id=target.agent_id,
                session_type="delegated_task",
                parent_session_id=parent_session_id,
                enable_user_question=False,
                lock_workspace=False,
            )
            response = await self._run_child(
                container,
                task,
                build_delegate_execute_prompt(),
                cancellation_token,
            )
        return self._render_result(target.agent_id, response, getattr(container.session_store, "session_id", None))

    async def _run_inspect(self, target, task: str, cancellation_token: CancellationToken | None) -> str:
        with preserve_active_session_context(), tempfile.TemporaryDirectory(prefix="rind-inspect-") as session_dir:
            container = self._build_container(
                workspace_root=str(target.workspace_root),
                session_dir=session_dir,
                project_id=self._project.project_id,
                owner_agent_id=target.agent_id,
                session_type="inspect",
                parent_session_id=None,
                enable_user_question=False,
                enabled_tools=("read_file", "glob", "grep", "skill"),
                lock_workspace=False,
            )
            response = await self._run_child(
                container,
                task,
                build_delegate_inspect_prompt(),
                cancellation_token,
            )
        return self._render_result(target.agent_id, response, None)

    def _build_container(self, **kwargs):
        builder = self._container_builder
        if builder is None:
            from agent.bootstrap import build_agent_container

            builder = build_agent_container
        return builder(
            settings=self._settings,
            provider_client_factory=self._provider_client_factory,
            **kwargs,
        )

    async def _run_child(self, container, task: str, instruction: str, cancellation_token: CancellationToken | None) -> dict[str, str]:
        text = ""
        async for event in container.runtime.run_turn(
            query=task,
            cancellation_token=cancellation_token,
            transient_system_messages=[{"role": "system", "content": instruction, "_context_kind": "delegate"}],
        ):
            if isinstance(event, AssistantMessageCompletedEvent):
                text = event.content
            elif isinstance(event, TurnCancelledEvent):
                return {"error": event.reason or "cancelled", "error_type": "Cancelled"}
            elif isinstance(event, TurnFailedEvent):
                return {"error": event.error or "Delegated turn failed.", "error_type": event.error_type or "DelegatedTurnFailed"}
        return {"content": text}

    def _render_result(self, agent_id: str, response: dict[str, str], session_id: str | None) -> str:
        if "error" in response:
            error_type = response.get("error_type") or "DelegatedTurnFailed"
            if error_type == "Cancelled":
                return tool_cancelled("delegate", response["error"])
            return tool_error("delegate", response["error"], error_type, meta={"agent_id": agent_id})
        result = _parse_child_result(response.get("content", ""))
        payload: dict[str, Any] = {
            "agent_id": agent_id,
            "status": result["status"],
            "summary": result["summary"],
            "published_paths": self._published_paths(result["published_paths"]),
        }
        if session_id:
            payload["session_id"] = session_id
        return tool_ok("delegate", payload)

    def _published_paths(self, paths: list[str]) -> list[str]:
        published: list[str] = []
        for raw_path in paths:
            candidate = Path(raw_path).expanduser()
            if not candidate.is_absolute():
                candidate = self._project.project_root / candidate
            candidate = candidate.resolve()
            try:
                relative = candidate.relative_to(self._project.shared_root)
            except ValueError:
                continue
            if candidate.exists():
                published.append((Path("shared") / relative).as_posix())
        return list(dict.fromkeys(published))


def _parse_child_result(content: str) -> dict[str, Any]:
    raw = str(content or "").strip()
    parsed = _json_object(raw)
    if parsed is None:
        return {
            "status": "completed",
            "summary": raw[:_MAX_SUMMARY_CHARS] or "Delegated turn completed without a text summary.",
            "published_paths": [],
        }
    status = str(parsed.get("status") or "completed").strip().lower()
    if status not in {"completed", "blocked"}:
        status = "completed"
    summary = str(parsed.get("summary") or "").strip()[:_MAX_SUMMARY_CHARS]
    if not summary:
        summary = "Delegated turn completed without a text summary."
    raw_paths = parsed.get("published_paths")
    paths = [str(path).strip() for path in raw_paths if isinstance(path, str) and path.strip()] if isinstance(raw_paths, list) else []
    return {"status": status, "summary": summary, "published_paths": paths}


def _json_object(content: str) -> dict[str, Any] | None:
    start = content.find("{")
    end = content.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(content[start : end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None
