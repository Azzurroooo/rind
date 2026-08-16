"""Clear output slash command."""

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_clear(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if args:
        return SlashCommandResult("Usage: /clear")
    return SlashCommandResult(clear_screen=True)


COMMAND = SlashCommandInfo(
    name="clear",
    description="Clear terminal output",
    usage="/clear",
    handler=handle_clear,
)
