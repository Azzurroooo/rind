"""Explicit catalog for built-in tools."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from agent.infrastructure.tools.spec import ToolSpec

from .files import TOOL_SPECS as FILE_TOOL_SPECS
from .goal import create_goal_tool_spec
from .planning import TOOL_SPECS as PLANNING_TOOL_SPECS
from .shell import TOOL_SPECS as SHELL_TOOL_SPECS
from .skill import build_skill_tool_specs
from .user_question import TOOL_SPECS as USER_QUESTION_TOOL_SPECS
from .web import TOOL_SPECS as WEB_TOOL_SPECS


def build_builtin_tool_specs(
    *,
    enable_goal: bool = False,
    enable_user_question: bool = True,
    set_goal_status: Callable[[str], Awaitable[dict[str, str]]] | None = None,
    skill_repository=None,
) -> tuple[ToolSpec, ...]:
    specs = list(FILE_TOOL_SPECS)
    if enable_user_question:
        specs[0:0] = USER_QUESTION_TOOL_SPECS
    specs.extend(SHELL_TOOL_SPECS)
    specs.extend(PLANNING_TOOL_SPECS)
    specs.extend(build_skill_tool_specs(skill_repository))
    specs.extend(WEB_TOOL_SPECS)
    if enable_goal:
        if set_goal_status is None:
            raise ValueError("Goal tool requires a session goal status setter.")
        specs.append(create_goal_tool_spec(set_goal_status))
    return tuple(specs)


TOOL_SPECS: tuple[ToolSpec, ...] = build_builtin_tool_specs()


__all__ = ["TOOL_SPECS", "build_builtin_tool_specs", "create_goal_tool_spec"]
