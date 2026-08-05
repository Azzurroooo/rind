"""Status slash command."""

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult
from ..status_view import build_status_display, render_status_display


async def handle_status(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args:
        return "Usage: /status"
    display = await build_status_display(context)
    return SlashCommandResult(render_status_display(display), display=display)


COMMAND = SlashCommandInfo(
    name="status",
    description="Show session status",
    usage="/status",
    handler=handle_status,
)
