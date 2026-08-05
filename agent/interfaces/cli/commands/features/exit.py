"""Exit slash command."""

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_exit(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    return SlashCommandResult("再见！", should_exit=True)


COMMAND = SlashCommandInfo(
    name="exit",
    description="Exit CLI",
    usage="/exit",
    aliases=("quit",),
    handler=handle_exit,
)
