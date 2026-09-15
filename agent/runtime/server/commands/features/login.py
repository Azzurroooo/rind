"""Login setup slash command."""

from ..router import SlashCommandContext, SlashCommandInfo


async def handle_login(context: SlashCommandContext, args: list[str]) -> str:
    if len(args) > 1:
        return "Usage: /login [provider]"
    return "Use the provider login flow from the CLI."


COMMAND = SlashCommandInfo(
    name="login",
    description="Configure a provider",
    usage="/login [provider]",
    handler=handle_login,
)
