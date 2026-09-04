"""Model selection slash command."""

from agent.infrastructure.config.settings_loader import DEFAULT_MODEL
from agent.runtime.server.commands.formatting import display_value

from ..model_control import _default_model, normalize_model_name, set_active_model
from ..router import SlashCommandContext, SlashCommandInfo


async def handle_model(context: SlashCommandContext, args: list[str]) -> str:
    configured = _default_model(context.session)
    if not args:
        active = display_value(getattr(context.session, "model", None))
        configured = display_value(configured)
        if active == configured:
            return f"Model: {active}"
        return f"Model:\n- active: {active}\n- default: {configured}"

    if len(args) != 2 or args[0].lower() != "set":
        return "Usage: /model or /model set <model>"

    model = normalize_model_name(args[1])
    if model is None:
        return "Usage: /model set <model>"

    try:
        result = await set_active_model(context.runtime, context.session, model)
        active_updated = bool(result.get("active_updated"))
    except Exception as exc:
        return f"Command failed: {exc}"

    session_model = display_value(result.get("session_model") or result.get("model") or model)
    default_model = display_value(result.get("default_model") or configured or DEFAULT_MODEL)
    lines = [
        "Session model updated.",
        f"- session model: {session_model}",
        f"- default model: {default_model} (unchanged)",
    ]
    if active_updated:
        lines.append("- active session: updated")
    else:
        lines.append("- active turn: unchanged; the new model applies to the next turn")
    return "\n".join(lines)


COMMAND = SlashCommandInfo(
    name="model",
    description="Show or change the active model",
    usage="/model | /model set <model>",
    handler=handle_model,
)
