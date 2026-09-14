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
        description="Create a standard Team Agent Capsule from an Agent ID and a responsibility description. The directory itself is the registration result; no Session or organization state is created.",
        param_descriptions={
            "agent_id": "Directory id of the new Agent.",
            "description": "Responsibilities and scope of work for the new Agent.",
        },
    )
