"""Status slash command: the model, the provider behind it, the conversation and its context use."""

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
    description="Show model, provider, conversation and context use",
    usage="/status",
    handler=handle_status,
)


# Each entry is {group, label, value} with optional `note` (shown dimmer, after
# the value), `tone: "warning"` for something to fix, `note_tone: "accent"` for a
# setup that is not the default, and `actions`: commands named in the note.
GROUP_TITLES = {"model": "Model", "provider": "Provider", "conversation": "Conversation"}

# Where a conversation's model or effort came from (see /model, /effort and folder defaults).
SOURCE_LABELS = {
    "session": "this conversation",
    "folder": "folder default",
    "main_repository": "main repository default",
    "settings": "settings.json",
}
KIND_NOTES = {
    "builtin": "built-in",
    "custom": "custom · providers.json",
    "overridden": "built-in · endpoint from providers.json",
}


def render_status_display(display: dict) -> str:
    """The plain-text form, for clients that do not draw the structured display."""
    lines = ["```text"]
    selection = display.get("selection")
    if isinstance(selection, dict) and selection.get("model"):
        lines.extend([f"Status: {selection_summary(selection)}", ""])
    entries = [entry for entry in display.get("entries") or [] if isinstance(entry, dict)]
    for group, title in GROUP_TITLES.items():
        grouped = [entry for entry in entries if entry.get("group") == group]
        if grouped:
            lines.append(f"{title}:")
            lines.extend(f"  {_entry_line(entry)}" for entry in grouped)
            lines.append("")
    lines.append("Context:")
    usage_items = display.get("usage")
    usage = usage_items[0] if isinstance(usage_items, list) and usage_items else None
    lines.extend(f"  {line}" for line in (_usage_lines(usage) if isinstance(usage, dict) else ["no completed sampling yet"]))
    footer = [_entry_line(entry) for entry in entries if entry.get("group") not in GROUP_TITLES]
    if footer:
        lines.extend(["", *footer])
    lines.append("```")
    return "\n".join(lines)


def selection_summary(selection: dict) -> str:
    model = " / ".join(str(selection.get(key) or "") for key in ("provider", "model") if selection.get(key))
    effort = str(selection.get("reasoning_effort") or "")
    return f"{model} · {effort}" if effort else model


def _entry_line(entry: dict) -> str:
    note = str(entry.get("note") or "")
    return f"{entry.get('label', '')}: {entry.get('value', '')}" + (f" · {note}" if note else "")


async def build_status_display(context: SlashCommandContext) -> dict:
    session = context.session
    session_id = getattr(session, "session_id", None)
    entries: list[dict] = []
    selection: dict[str, str] = {}
    if context.explain_selection is not None:
        try:
            explained = await _explained(context, session, session_id)
        except (OSError, ValueError) as exc:
            entries.append(_entry("provider", "provider", "unavailable", str(exc), tone="warning"))
        else:
            selection = {key: str(explained.get(key) or "") for key in ("provider", "model", "reasoning_effort")}
            entries.extend(_model_entries(explained))
            entries.extend(_provider_entries(explained))
    entries.extend([
        _entry("conversation", "session", display_value(session_id), "") if session_id
        else _entry("conversation", "session", "none", "the first message starts it"),
        _entry("conversation", "name", *await _name_value(session, session_id, context.draft)),
        _settings_entry(),
    ])
    usage = await _latest_assistant_sampling_usage(session)
    return {"type": "status", "selection": selection, "entries": entries, "usage": [_usage_display(usage)] if usage else []}


def _entry(group: str, label: str, value: str, note: str = "", **extra) -> dict:
    entry = {"group": group, "label": label, "value": value}
    if note:
        entry["note"] = note
    entry.update({key: item for key, item in extra.items() if item})
    return entry


def _settings_entry() -> dict:
    try:
        settings = load_settings()
    except (OSError, ValueError) as exc:
        return _entry("settings", "settings", "unavailable", str(exc), tone="warning")
    return _entry("settings", "settings", str(settings.settings_path), "" if settings.settings_exists else "not created · defaults apply")


async def _explained(context: SlashCommandContext, session, session_id) -> dict:
    # Before the first message the window's own choices are what the
    # conversation will be created with.
    if not session_id:
        return await context.explain_selection(dict(context.draft or {}), None)
    selection = {key: str(getattr(session, key, "") or "") for key in ("provider", "model", "reasoning_effort")}
    return await context.explain_selection(selection, getattr(session, "selection_source", None) or {})


def _model_entries(explained: dict) -> list[dict]:
    return [
        _entry("model", "model", display_value(explained.get("model")), SOURCE_LABELS.get(str(explained.get("model_source") or ""), "")),
        _entry("model", "effort", display_value(explained.get("reasoning_effort") or "unset"),
               SOURCE_LABELS.get(str(explained.get("effort_source") or ""), "")),
    ]


def _provider_entries(explained: dict) -> list[dict]:
    connection = explained.get("connection")
    if not connection:
        return [_entry("provider", "provider", display_value(explained.get("provider")), "not configured · /login or /model",
                       tone="warning", actions=["/login", "/model"])]
    kind = str(connection.get("kind") or "builtin")
    return [
        _entry("provider", "provider", display_value(connection.get("name")), KIND_NOTES.get(kind, ""),
               note_tone="accent" if kind != "builtin" else ""),
        _auth_entry(connection),
        _entry("provider", "endpoint", display_value(connection.get("endpoint")), str(connection.get("api") or "")),
    ]


def _auth_entry(connection: dict) -> dict:
    """How requests sign in; the key itself is never shown."""
    auth = str(connection.get("auth") or "")
    credential = str(connection.get("credential") or "")
    env_key = str(connection.get("env_key") or "")
    if auth == "oauth":
        account = str(connection.get("account") or "account")
        return _entry("provider", "auth", f"{account} sign-in", "OAuth", note_tone="accent")
    if credential == "stored":
        return _entry("provider", "auth", "API key", "saved login")
    if credential == "environment":
        return _entry("provider", "auth", "API key", f"env {env_key}" if env_key else "environment variable")
    return _entry("provider", "auth", "not signed in", f"/login or set {env_key}" if env_key else "/login",
                  tone="warning", actions=["/login"])


async def _name_value(session, session_id, draft: dict | None) -> tuple[str, str]:
    """The name and a note: what the conversation is shown as without one (see /rename)."""
    if not session_id:
        pending = str((draft or {}).get("name") or "").strip()
        return (pending, "applies when the conversation starts") if pending else ("unset", "shown by its first message")
    get_metadata = getattr(session, "get_metadata", None)
    meta = await get_metadata() if callable(get_metadata) else {}
    name = meta.get("name") if isinstance(meta, dict) else None
    if isinstance(name, str) and name.strip():
        return name, ""
    title = display_title(meta) if isinstance(meta, dict) else ""
    return ("unset", f'shown as "{title}"') if title else ("unset", "shown by its first message")


async def _latest_assistant_sampling_usage(session) -> dict | None:
    get_usage = getattr(session, "get_latest_assistant_sampling_usage", None)
    if not callable(get_usage):
        return None
    try:
        usage = await get_usage()
        return dict(usage) if isinstance(usage, dict) else None
    except Exception:
        return None


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
