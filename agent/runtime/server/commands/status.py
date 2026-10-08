"""Status slash command."""

from __future__ import annotations

from agent.infrastructure.persistence.session_meta import display_title
from agent.infrastructure.settings import load_settings
from agent.runtime.server.commands.contracts import SlashCommandContext, SlashCommandInfo, SlashCommandResult
from agent.runtime.server.commands.formatting import display_value, nonnegative_int


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


# Where a conversation's model or effort came from (see /model, /effort and folder defaults).
SOURCE_LABELS = {
    "session": "this conversation",
    "folder": "folder default",
    "main_repository": "main repository default",
    "settings": "settings.json",
}
KEY_LABELS = {"settings": "settings.json", "stored": "stored login", "environment": "environment variable", "none": "not set · /login"}


async def build_status_display(context: SlashCommandContext) -> dict:
    session = context.session
    session_id = getattr(session, "session_id", None)
    entries = [
        {"label": "session", "value": display_value(session_id) if session_id else "none · the first message starts it"},
        {"label": "name", "value": await _name_value(session, session_id, context.draft)},
    ]
    try:
        settings = load_settings()
        entries.append({"label": "settings", "value": str(settings.settings_path), "state": "found" if settings.settings_exists else "missing"})
        if context.explain_selection is not None:
            entries.extend(_selection_entries(await _explained(context, session, session_id)))
    except (OSError, ValueError) as exc:
        entries.append({"label": "settings", "value": f"unavailable: {exc}"})
    usage = await _latest_assistant_sampling_usage(session)
    return {"type": "status", "entries": entries, "usage": [_usage_display(usage)] if usage else []}


async def _explained(context: SlashCommandContext, session, session_id) -> dict:
    # Before the first message the window's own choices are what the
    # conversation will be created with.
    if not session_id:
        return await context.explain_selection(dict(context.draft or {}), None)
    selection = {key: str(getattr(session, key, "") or "") for key in ("provider", "model", "reasoning_effort")}
    return await context.explain_selection(selection, getattr(session, "selection_source", None) or {})


def _selection_entries(explained: dict) -> list[dict]:
    connection = explained.get("connection")
    provider = display_value(explained.get("provider"))
    entries = [{"label": "connection", "value": f"{provider} · {connection['name']}" if connection else f"{provider} · not configured · /login or /model"}]
    if connection:
        entries.extend([
            {"label": "endpoint", "value": display_value(connection.get("endpoint"))},
            {"label": "key", "value": KEY_LABELS.get(str(connection.get("credential")), "not set · /login")},
        ])
    entries.extend([
        {"label": "model", "value": _with_source(display_value(explained.get("model")), explained.get("model_source"))},
        {"label": "reasoningEffort", "value": _with_source(display_value(explained.get("reasoning_effort") or "unset"), explained.get("effort_source"))},
    ])
    return entries


def _with_source(value: str, source: object) -> str:
    label = SOURCE_LABELS.get(str(source or ""))
    return f"{value} · {label}" if label else value


async def _name_value(session, session_id, draft: dict | None) -> str:
    """The name, or what the conversation is shown as without one (see /rename)."""
    if not session_id:
        pending = str((draft or {}).get("name") or "").strip()
        return f"{pending} · applies when the conversation starts" if pending else "unset · shown by its first message"
    get_metadata = getattr(session, "get_metadata", None)
    meta = await get_metadata() if callable(get_metadata) else {}
    name = meta.get("name") if isinstance(meta, dict) else None
    if isinstance(name, str) and name.strip():
        return name
    title = display_title(meta) if isinstance(meta, dict) else ""
    return f'unset · shown as "{title}"' if title else "unset · shown by its first message"


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
