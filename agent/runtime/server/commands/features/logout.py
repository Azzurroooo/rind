"""Logout slash command metadata."""

from ..router import SlashCommandContext, SlashCommandInfo


async def handle_logout(context: SlashCommandContext, args: list[str]) -> str:
    if len(args) > 1:
        return "Usage: /logout [provider]"
    return "Use the provider logout flow from the CLI."


COMMAND = SlashCommandInfo(
    name="logout",
    description="Remove stored provider credentials",
    usage="/logout [provider]",
    handler=handle_logout,
)
