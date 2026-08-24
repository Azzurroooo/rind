"""Synchronous Team Capsule delegation without a Team control plane."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent.domain import tool_cancelled, tool_error, tool_ok
from agent.domain.cancellation import CancellationToken
from agent.infrastructure.team import TeamProject, resolve_team_agent
from agent.prompts import build_delegate_execute_prompt, build_delegate_inspect_prompt


_MAX_SUMMARY_CHARS = 4_000


class TeamDelegator:
    """Run one target Capsule and return its compact result to the parent tool call."""

    def __init__(
        self,
        *,
        project: TeamProject,
        parent_session,
        session_runner,
    ) -> None:
        self._project = project
        self._parent_session = parent_session
        self._session_runner = session_runner

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
        if not callable(self._session_runner):
            return tool_error("delegate", "Worker session execution is unavailable.", "UnsupportedOperation")

        if normalized_mode == "inspect":
            return await self._run_inspect(target, normalized_task, cancellation_token)
        return await self._run_execute(target, normalized_task, parent_session_id, cancellation_token)

    async def _run_execute(self, target, task: str, parent_session_id: str, cancellation_token: CancellationToken | None) -> str:
        response, session_id = await self._session_runner(
            target=target,
            project=self._project,
            parent_session_id=parent_session_id,
            task=task,
            instruction=build_delegate_execute_prompt(),
            cancellation_token=cancellation_token,
            persistent=True,
        )
        return self._render_result(target.agent_id, response, session_id)

    async def _run_inspect(self, target, task: str, cancellation_token: CancellationToken | None) -> str:
        response, _ = await self._session_runner(
            target=target,
            project=self._project,
            parent_session_id=None,
            task=task,
            instruction=build_delegate_inspect_prompt(),
            cancellation_token=cancellation_token,
            persistent=False,
            enabled_tools=("read_file", "glob", "grep", "skill"),
        )
        return self._render_result(target.agent_id, response, None)

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
