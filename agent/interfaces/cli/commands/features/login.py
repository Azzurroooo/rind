"""Login setup slash command."""

from ..router import SlashCommandContext, SlashCommandInfo


async def handle_login(context: SlashCommandContext, args: list[str]) -> str:
    return "Login/config setup is not implemented yet.\nCreate settings.json under RIND_HOME, or ~/.rind when RIND_HOME is unset."


COMMAND = SlashCommandInfo(
    name="login",
    description="Show login setup guidance",
    usage="/login",
    handler=handle_login,
)
