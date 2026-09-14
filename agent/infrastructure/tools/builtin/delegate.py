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
            "Synchronously delegate a well-defined task to a specialist Agent of the current Team. "
            "execute creates a new target Agent Session and waits for its result; inspect only checks "
            "the target workspace and shared, persisting no child Session."
        ),
        param_descriptions={
            "agent_id": "Directory id of the target Agent within the current Team.",
            "task": "Complete, self-contained task description to execute or inspect.",
            "mode": {"description": "Delegation mode. Default execute.", "enum": ["execute", "inspect"]},
        },
    )
