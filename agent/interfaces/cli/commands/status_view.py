"""Status text rendering for CLI slash commands."""

from __future__ import annotations

from agent.interfaces.cli.formatting import display_value, nonnegative_int

from .router import SlashCommandContext


async def render_status(context: SlashCommandContext) -> str:
    display = await build_status_display(context)
    return render_status_display(display)


def render_status_display(display: dict) -> str:
    lines = [
        "```text",
        "Status:",
        f"Session: {display['session']}",
        f"Model: {display['model']}",
        f"Debug: {str(bool(display['debug'])).lower()}",
        f"Messages: {display['messages']}",
    ]
    git_status = display.get("git")
    if isinstance(git_status, dict):
        marker = "*" if git_status.get("dirty") else ""
        lines.append(f"Git: {display_value(git_status.get('branch'))}{marker}")
    for usage in display.get("usage") or []:
        if isinstance(usage, dict):
            lines.extend(_usage_lines(str(usage.get("label") or "Last sampling:"), usage))
    lines.append("```")
    return "\n".join(lines)


async def build_status_display(context: SlashCommandContext) -> dict:
    session = context.session
    message_count = await _message_count(session)
    display = {
        "type": "status",
        "session": display_value(getattr(session, "session_id", None)),
        "model": display_value(getattr(session, "model", None)),
        "debug": bool(context.debug),
        "messages": message_count,
    }
    git_status = _git_status_display()
    if git_status:
        display["git"] = git_status
    assistant_usage = await _latest_assistant_sampling_usage(session)
    latest_usage = await _latest_sampling_usage(session)
    usage_items = []
    if assistant_usage:
        usage_items.append(_usage_display("Assistant sampling:", assistant_usage))
        if latest_usage and latest_usage.get("sampling_kind") != "assistant":
            label = f"Latest request ({latest_usage.get('sampling_kind') or 'unknown'}):"
            usage_items.append(_usage_display(label, latest_usage))
    elif latest_usage:
        usage_items.append(_usage_display("Last sampling:", latest_usage))
    if usage_items:
        display["usage"] = usage_items
    return display


async def _message_count(session) -> str:
    get_messages = getattr(session, "get_messages_slice", None)
    if not callable(get_messages):
        return "unknown"
    try:
        return str(len(await get_messages()))
    except Exception:
        return "unknown"


def _git_status_display() -> dict | None:
    try:
        from agent.interfaces.cli.ui import GitPromptStatusProvider

        status = GitPromptStatusProvider(ttl_seconds=0).current()
    except Exception:
        return None
    if status is None:
        return None
    return {"branch": display_value(status.branch), "dirty": bool(status.dirty)}


async def _latest_sampling_usage(session) -> dict | None:
    get_usage = getattr(session, "get_latest_sampling_usage", None)
    if not callable(get_usage):
        return None
    try:
        usage = await get_usage()
        return dict(usage) if isinstance(usage, dict) else None
    except Exception:
        return None


async def _latest_assistant_sampling_usage(session) -> dict | None:
    get_usage = getattr(session, "get_latest_assistant_sampling_usage", None)
    if not callable(get_usage):
        return None
    try:
        usage = await get_usage()
        return dict(usage) if isinstance(usage, dict) else None
    except Exception:
        return None


def _usage_lines(label: str, usage: dict) -> list[str]:
    context_window = nonnegative_int(usage.get("context_window_tokens"))
    input_tokens = nonnegative_int(usage.get("input_tokens"))
    cached_tokens = nonnegative_int(usage.get("cached_input_tokens"))
    output_tokens = nonnegative_int(usage.get("output_tokens"))
    limit = f" / {_format_count(context_window)}" if context_window > 0 else ""
    return [
        "",
        label,
        f"input: {_format_count(input_tokens)}{limit} ({_format_percent(usage.get('context_usage_percent'))})",
        f"cached: {_format_count(cached_tokens)} ({_format_percent(usage.get('cache_hit_rate'))})",
        f"output: {_format_count(output_tokens)}",
    ]


def _usage_display(label: str, usage: dict) -> dict:
    return {
        "label": label,
        "sampling_kind": str(usage.get("sampling_kind") or ""),
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
