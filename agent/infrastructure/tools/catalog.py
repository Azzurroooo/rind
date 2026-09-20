"""Explicit catalog for built-in tools."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Collection

from agent.infrastructure.tools.spec import ToolSpec

from agent.infrastructure.tools.files.specs import build_file_tool_specs
from agent.infrastructure.tools.files.mutation_queue import FileMutationQueue
from agent.infrastructure.tools.agent_create import create_agent_create_tool_spec
from agent.infrastructure.tools.delegate import create_delegate_tool_spec
from agent.infrastructure.tools.goal import create_goal_tool_spec
from agent.infrastructure.tools.planning import create_plan_tool_spec
from agent.infrastructure.tools.shell.specs import ShellTools, build_shell_tool_specs
from agent.infrastructure.tools.skill import build_skill_tool_specs
from agent.infrastructure.tools.user_question import TOOL_SPECS as USER_QUESTION_TOOL_SPECS
from agent.infrastructure.tools.web import build_web_tool_specs
from agent.infrastructure.tools.web.session_pool import WebSessions


def build_builtin_tool_specs(
    *,
    shell_tools: ShellTools,
    web_sessions: WebSessions,
    mutation_queue: FileMutationQueue | None = None,
    enable_goal: bool = False,
    enable_user_question: bool = True,
    set_goal_status: Callable[[str], Awaitable[dict[str, str]]] | None = None,
    skill_repository=None,
    delegate_handler: Callable[..., Awaitable[str]] | None = None,
    agent_create_project=None,
    workspace_root: str | None = None,
    allowed_roots: Collection[str] | None = None,
    shared_root: str | None = None,
    session_output_root: str | None = None,
    output_store=None,
    session_base_provider: Callable[[], str | None] | None = None,
) -> tuple[ToolSpec, ...]:
    specs = list(build_file_tool_specs(
        workspace_root, allowed_roots, shared_root, session_output_root, mutation_queue=mutation_queue,
    ))
    if enable_user_question:
        specs[0:0] = USER_QUESTION_TOOL_SPECS
    specs.extend(build_shell_tool_specs(shell_tools, workspace_root))
    specs.append(create_plan_tool_spec(session_base_provider))
    specs.extend(build_skill_tool_specs(skill_repository))
    if delegate_handler is not None:
        specs.append(create_delegate_tool_spec(delegate_handler))
    if agent_create_project is not None:
        specs.append(create_agent_create_tool_spec(agent_create_project))
    specs.extend(build_web_tool_specs(web_sessions))
    if enable_goal:
        if set_goal_status is None:
            raise ValueError("Goal tool requires a session goal status setter.")
        specs.append(create_goal_tool_spec(set_goal_status))
    return tuple(specs)


__all__ = ["build_builtin_tool_specs", "create_goal_tool_spec"]
