"""Configuration status slash command."""

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_config(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    from agent.infrastructure.config import Config

    api_key_state = "set" if Config.OPENAI_API_KEY else "unset"
    reasoning = Config.MODEL_REASONING_EFFORT or "unset"
    settings_state = "found" if Config.SETTINGS_EXISTS else "missing"
    entries = [
        {"label": "settings", "value": str(Config.SETTINGS_PATH), "state": settings_state},
        {"label": "apiKey", "value": api_key_state},
        {"label": "baseUrl", "value": str(Config.OPENAI_API_BASE)},
        {"label": "model", "value": str(Config.DEFAULT_MODEL)},
        {"label": "reasoningEffort", "value": str(reasoning)},
    ]
    return SlashCommandResult(
        "\n".join(
            [
                "Config:",
                f"- settings: {Config.SETTINGS_PATH} ({settings_state})",
                f"- apiKey: {api_key_state}",
                f"- baseUrl: {Config.OPENAI_API_BASE}",
                f"- model: {Config.DEFAULT_MODEL}",
                f"- reasoningEffort: {reasoning}",
            ]
        ),
        display={"type": "config", "entries": entries},
    )


COMMAND = SlashCommandInfo(
    name="config",
    description="Show config guidance",
    usage="/config",
    handler=handle_config,
)
