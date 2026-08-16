"""Minimal Team project initialization command."""

from __future__ import annotations

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


USAGE = "/team create [project-id]"


async def handle_team(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if not args or args[0].lower() != "create" or len(args) > 2:
        return SlashCommandResult(f"Usage: {USAGE}")
    create_team = getattr(context.session, "create_team_project", None)
    if not callable(create_team):
        return SlashCommandResult("Team project creation is not supported by this session store.")
    created = await create_team(project_id=args[1] if len(args) == 2 else None)
    text = (
        f"Team project created: {created['project_id']}\n"
        f"Main agent: {created['main_agent']}\n"
        f"Workspace: {created['workspace_root']}"
    )
    return SlashCommandResult(
        text,
        display={
            "type": "team_create",
            "project_id": created["project_id"],
            "main_agent": created["main_agent"],
            "workspace_root": created["workspace_root"],
        },
    )


COMMAND = SlashCommandInfo(
    name="team",
    description="Create a Team project",
    usage=USAGE,
    handler=handle_team,
)
