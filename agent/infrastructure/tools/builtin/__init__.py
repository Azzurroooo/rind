"""Explicit catalog for built-in tools."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Collection

from agent.infrastructure.tools.spec import ToolSpec

from .files import build_file_tool_specs
from .agent_create import create_agent_create_tool_spec
from .delegate import create_delegate_tool_spec
from .goal import create_goal_tool_spec
from .planning import TOOL_SPECS as PLANNING_TOOL_SPECS
from .shell import build_shell_tool_specs
from .skill import build_skill_tool_specs
from .user_question import TOOL_SPECS as USER_QUESTION_TOOL_SPECS
from .web import TOOL_SPECS as WEB_TOOL_SPECS


def build_builtin_tool_specs(
    *,
    enable_goal: bool = False,
    enable_user_question: bool = True,
    set_goal_status: Callable[[str], Awaitable[dict[str, str]]] | None = None,
    skill_repository=None,
    delegate_handler: Callable[..., Awaitable[str]] | None = None,
    agent_create_project=None,
    workspace_root: str | None = None,
    allowed_roots: Collection[str] | None = None,
    shared_root: str | None = None,
) -> tuple[ToolSpec, ...]:
    specs = list(build_file_tool_specs(workspace_root, allowed_roots, shared_root))
    if enable_user_question:
        specs[0:0] = USER_QUESTION_TOOL_SPECS
    specs.extend(build_shell_tool_specs(workspace_root))
    specs.extend(PLANNING_TOOL_SPECS)
    specs.extend(build_skill_tool_specs(skill_repository))
    if delegate_handler is not None:
        specs.append(create_delegate_tool_spec(delegate_handler))
    if agent_create_project is not None:
        specs.append(create_agent_create_tool_spec(agent_create_project))
    specs.extend(WEB_TOOL_SPECS)
    if enable_goal:
        if set_goal_status is None:
            raise ValueError("Goal tool requires a session goal status setter.")
        specs.append(create_goal_tool_spec(set_goal_status))
    return tuple(specs)


TOOL_SPECS: tuple[ToolSpec, ...] = build_builtin_tool_specs()


__all__ = ["TOOL_SPECS", "build_builtin_tool_specs", "create_goal_tool_spec"]
