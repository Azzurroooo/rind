"""Main-Agent-only synchronous delegation tool."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from agent.domain.cancellation import CancellationToken
from agent.infrastructure.tools.spec import ToolSpec


def create_delegate_tool_spec(
    handler: Callable[[str, str, str, CancellationToken | None], Awaitable[str]],
) -> ToolSpec:
    async def delegate(
        agent_id: str,
        task: str,
        mode: str = "execute",
        _cancellation_token: CancellationToken | None = None,
    ) -> str:
        return await handler(agent_id, task, mode, _cancellation_token)

    return ToolSpec(
        name="delegate",
        handler=delegate,
        description=(
            "同步委派一个明确任务给当前 Team 的专长 Agent。execute 会创建新的目标 Agent Session 并等待结果；"
            "inspect 只检查目标工作区和 shared，不持久化子 Session。"
        ),
        param_descriptions={
            "agent_id": "当前 Team 中目标 Agent 的目录 id。",
            "task": "完整、可独立执行或检查的任务说明。",
            "mode": {"description": "委派模式。默认 execute。", "enum": ["execute", "inspect"]},
        },
    )
