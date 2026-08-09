"""Main-Agent-only Blueprint materialization tool."""

from __future__ import annotations

from agent.domain import tool_error, tool_ok
from agent.infrastructure.team import TeamProject, materialize_team_agent
from agent.infrastructure.tools.spec import ToolSpec


def create_agent_create_tool_spec(project: TeamProject) -> ToolSpec:
    def agent_create(agent_id: str, blueprint: str) -> str:
        try:
            capsule = materialize_team_agent(project, agent_id=agent_id, blueprint=blueprint)
        except ValueError as exc:
            return tool_error("agent_create", str(exc), "AgentCreateFailed")
        return tool_ok(
            "agent_create",
            {
                "agent_id": capsule.agent_id,
                "name": capsule.name,
                "workspace_root": str(capsule.workspace_root),
                "blueprint": str(blueprint).strip(),
            },
        )

    return ToolSpec(
        name="agent_create",
        handler=agent_create,
        description="从用户级 Blueprint 物化一个新的 Team Agent Capsule。目录本身即为注册结果，不创建 Session 或组织状态。",
        param_descriptions={
            "agent_id": "新 Agent 的目录 id。",
            "blueprint": "用户级 ~/.rind/blueprints 下的 Blueprint id。",
        },
    )
