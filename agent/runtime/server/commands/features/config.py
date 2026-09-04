"""Configuration status slash command."""

from agent.infrastructure.config.settings_loader import load_settings

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_config(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    try:
        settings = load_settings(context.workspace_root)
    except (OSError, ValueError) as exc:
        return SlashCommandResult(f"Config unavailable: {exc}")
    api_key_state = "set" if settings.api_key else "unset"
    reasoning = settings.reasoning_effort or "unset"
    settings_state = "found" if settings.settings_exists else "missing"
    entries = [
        {"label": "settings", "value": str(settings.settings_path), "state": settings_state},
        {"label": "apiKey", "value": api_key_state},
        {"label": "baseUrl", "value": str(settings.base_url)},
        {"label": "model", "value": str(settings.model)},
        {"label": "reasoningEffort", "value": str(reasoning)},
    ]
    return SlashCommandResult(
        "\n".join(
            [
                "Config:",
                f"- settings: {settings.settings_path} ({settings_state})",
                f"- apiKey: {api_key_state}",
                f"- baseUrl: {settings.base_url}",
                f"- model: {settings.model}",
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
