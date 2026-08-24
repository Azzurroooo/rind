"""Main-Agent-only Blueprint materialization tool."""

from __future__ import annotations

from agent.domain import tool_error, tool_ok
from agent.infrastructure.team import TeamProject, initialize_team_agent
from agent.infrastructure.tools.spec import ToolSpec


def create_agent_create_tool_spec(project: TeamProject) -> ToolSpec:
    def agent_create(agent_id: str, description: str) -> str:
        try:
            capsule = initialize_team_agent(project, agent_id=agent_id, description=description)
        except ValueError as exc:
            return tool_error("agent_create", str(exc), "AgentCreateFailed")
        return tool_ok(
            "agent_create",
            {
                "agent_id": capsule.agent_id,
                "name": capsule.name,
                "workspace_root": str(capsule.workspace_root),
                "description": str(description).strip(),
            },
        )

    return ToolSpec(
        name="agent_create",
        handler=agent_create,
        description="根据 Agent ID 和职责描述创建标准 Team Agent Capsule。目录本身即为注册结果，不创建 Session 或组织状态。",
        param_descriptions={
            "agent_id": "新 Agent 的目录 id。",
            "description": "新 Agent 的职责和工作范围。",
        },
    )
