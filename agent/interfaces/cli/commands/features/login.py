"""Login setup slash command."""

from ..router import SlashCommandContext, SlashCommandInfo


async def handle_login(context: SlashCommandContext, args: list[str]) -> str:
    return "Login/config setup is not implemented yet.\nSet apiKey in ~/.rind/settings.json."


COMMAND = SlashCommandInfo(
    name="login",
    description="Show login setup guidance",
    usage="/login",
    handler=handle_login,
)
