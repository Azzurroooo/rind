"""Team project and Agent management commands."""

from __future__ import annotations

from agent.infrastructure.team import discover_agent, initialize_team_agents, list_agent_blueprints, list_team_agents, materialize_team_agent
from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult

USAGE = "/team create [project-id] | /team init | /team list | /team blueprint [id] | /team add <description>"


async def handle_team(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if not args:
        return SlashCommandResult(f"Usage: {USAGE}")
    action = args[0].lower()
    if action == "create":
        return await _create_project(context, args[1:])
    agent = _main_agent_context(context)
    if isinstance(agent, str):
        return SlashCommandResult(agent)
    if action == "init" and len(args) == 1:
        return _init_agents(agent.project)
    if action == "list" and len(args) == 1:
        return _list_agents(agent.project)
    if action == "blueprint" and len(args) in {1, 2}:
        return _blueprints(agent.project, args[1] if len(args) == 2 else None)
    if action == "add" and len(args) >= 2:
        description = " ".join(args[1:]).strip()
        return SlashCommandResult(
            f"Preparing a Team Agent for: {description}",
            next_prompt={
                "input": f"Create a Team Agent for this responsibility: {description}",
                "transient_system_messages": [{
                    "role": "system",
                    "content": "Use agent_create with a stable kebab-case agent_id and the user's responsibility description. Do not use a blueprint.",
                    "_context_kind": "team_agent_creation",
                }],
            },
        )
    return SlashCommandResult(f"Usage: {USAGE}")


async def _create_project(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if len(args) > 1:
        return SlashCommandResult("Usage: /team create [project-id]")
    create_team = getattr(context.session, "create_team_project", None)
    if not callable(create_team):
        return SlashCommandResult("Team project creation is not supported by this session store.")
    created = await create_team(project_id=args[0] if args else None)
    text = f"Team project created: {created['project_id']}\nMain agent: {created['main_agent']}\nWorkspace: {created['workspace_root']}"
    return SlashCommandResult(text, display={"type": "team_create", **created})


def _main_agent_context(context: SlashCommandContext):
    try:
        resolved = discover_agent(context.workspace_root)
    except ValueError as exc:
        return f"Team context is invalid: {exc}"
    if resolved is None or resolved.project is None:
        return "Team management commands require a Team Agent workspace."
    if resolved.agent_id != resolved.project.main_agent:
        return "Only the Team main-agent can manage Team Agents."
    return resolved


def _init_agents(project) -> SlashCommandResult:
    result = initialize_team_agents(project)
    created = result["created"]
    skipped = result["skipped"]
    lines = [f"Team Agent initialization complete: {len(created)} created, {len(skipped)} skipped."]
    if created:
        lines.append(f"Created: {', '.join(created)}")
    return SlashCommandResult("\n".join(lines), display={"type": "team_init", **result})


def _list_agents(project) -> SlashCommandResult:
    agents = [{"id": agent.agent_id, "name": agent.name, "description": agent.description, "workspace_root": str(agent.workspace_root), "main": agent.agent_id == project.main_agent} for agent in list_team_agents(project)]
    lines = ["Team Agents:"] + [f"- {item['id']} | {item['name']} | {item['description']}" for item in agents]
    if len(lines) == 1:
        lines.append("- no valid agents found")
    return SlashCommandResult("\n".join(lines), display={"type": "team_agents", "agents": agents})


def _blueprints(project, selected: str | None) -> SlashCommandResult:
    blueprints = list_agent_blueprints()
    if selected is None:
        lines = ["Available blueprints:"] + [f"- {item['id']} | {item['name']} | {item['description']}" for item in blueprints]
        if not blueprints:
            lines.append("- no blueprints found")
        return SlashCommandResult("\n".join(lines), display={"type": "team_blueprints", "blueprints": blueprints})
    if not any(item["id"] == selected for item in blueprints):
        return SlashCommandResult(f"Blueprint not found: {selected}")
    try:
        capsule = materialize_team_agent(project, agent_id=selected, blueprint=selected)
    except ValueError as exc:
        return SlashCommandResult(f"Team Agent creation failed: {exc}")
    return SlashCommandResult(f"Team Agent created: {capsule.agent_id}\nWorkspace: {capsule.workspace_root}", display={"type": "team_agent_create", "agent_id": capsule.agent_id, "workspace_root": str(capsule.workspace_root), "blueprint": selected})


COMMAND = SlashCommandInfo(name="team", description="Manage the current Team", usage=USAGE, handler=handle_team)
