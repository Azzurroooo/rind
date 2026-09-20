from __future__ import annotations

from agent.infrastructure.settings import load_settings
from agent.runtime.server.commands.formatting import display_value, nonnegative_int
"""Status slash command."""

from agent.runtime.server.commands.contracts import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_status(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args:
        return "Usage: /status"
    display = await build_status_display(context)
    return SlashCommandResult(render_status_display(display), display=display)


COMMAND = SlashCommandInfo(
    name="status",
    description="Show config and assistant sampling",
    usage="/status",
    handler=handle_status,
)


def render_status_display(display: dict) -> str:
    lines = ["```text", "Config:"]
    lines.extend(_config_lines(display.get("entries")))
    lines.extend(["", "Assistant sampling:"])
    usage_items = display.get("usage")
    usage = usage_items[0] if isinstance(usage_items, list) and usage_items else None
    if isinstance(usage, dict):
        lines.extend(_usage_lines(usage))
    else:
        lines.append("no completed sampling yet")
    lines.append("```")
    return "\n".join(lines)



async def build_status_display(context: SlashCommandContext) -> dict:
    session = context.session
    entries = [{"label": "session", "value": display_value(getattr(session, "session_id", None))}]
    try:
        settings = load_settings(context.workspace_root)
        entries.extend([
            {
                "label": "settings",
                "value": str(settings.settings_path),
                "state": "found" if settings.settings_exists else "missing",
            },
            {"label": "apiKey", "value": "set" if settings.api_key else "unset"},
            {"label": "baseUrl", "value": str(settings.base_url)},
            {
                "label": "model",
                "value": display_value(getattr(session, "model", None) or settings.model),
            },
            {
                "label": "reasoningEffort",
                "value": display_value(
                    getattr(session, "reasoning_effort", None) or settings.reasoning_effort or "unset"
                ),
            },
        ])
    except (OSError, ValueError) as exc:
        entries.append({"label": "settings", "value": f"unavailable: {exc}"})
    usage = await _latest_assistant_sampling_usage(session)
    return {"type": "status", "entries": entries, "usage": [_usage_display(usage)] if usage else []}



async def _latest_assistant_sampling_usage(session) -> dict | None:
    get_usage = getattr(session, "get_latest_assistant_sampling_usage", None)
    if not callable(get_usage):
        return None
    try:
        usage = await get_usage()
        return dict(usage) if isinstance(usage, dict) else None
    except Exception:
        return None



def _config_lines(entries: object) -> list[str]:
    if not isinstance(entries, list):
        return ["settings           unavailable"]
    lines: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        label = str(entry.get("label") or "")
        value = str(entry.get("value") or "")
        state = f" ({entry['state']})" if entry.get("state") else ""
        lines.append(f"{label}: {value}{state}")
    return lines or ["settings           unavailable"]



def _usage_lines(usage: dict) -> list[str]:
    context_percent = _numeric_percent(usage.get("context_usage_percent"))
    context_window = nonnegative_int(usage.get("context_window_tokens"))
    input_tokens = nonnegative_int(usage.get("input_tokens"))
    cached_tokens = nonnegative_int(usage.get("cached_input_tokens"))
    output_tokens = nonnegative_int(usage.get("output_tokens"))
    limit = f" / {_format_count(context_window)} tokens" if context_window > 0 else ""
    lines = []
    if context_window > 0:
        filled = min(10, max(0, round(context_percent * 10)))
        lines.append(f"context: {'▮' * filled}{'▯' * (10 - filled)} {_format_percent(context_percent)}")
    lines.extend([
        f"input: {_format_count(input_tokens)}{limit}",
        f"cached: {_format_count(cached_tokens)} · {_format_percent(usage.get('cache_hit_rate'))} hit",
        f"output: {_format_count(output_tokens)}",
    ])
    return lines



def _usage_display(usage: dict) -> dict:
    return {
        "input_tokens": nonnegative_int(usage.get("input_tokens")),
        "context_window_tokens": nonnegative_int(usage.get("context_window_tokens")),
        "context_usage_percent": _numeric_percent(usage.get("context_usage_percent")),
        "cached_input_tokens": nonnegative_int(usage.get("cached_input_tokens")),
        "cache_hit_rate": _numeric_percent(usage.get("cache_hit_rate")),
        "output_tokens": nonnegative_int(usage.get("output_tokens")),
    }



def _format_count(value: object) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if abs(number) >= 1000:
        return f"{number / 1000:.1f}k"
    return str(int(number))



def _format_percent(value: object) -> str:
    if not isinstance(value, int | float):
        return "0.0%"
    return f"{value * 100:.1f}%"



def _numeric_percent(value: object) -> float:
    return float(value) if isinstance(value, int | float) else 0.0
