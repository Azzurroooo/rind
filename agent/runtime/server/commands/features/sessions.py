"""Session list slash command."""

from agent.runtime.server.commands.formatting import clip_text, display_value, nonnegative_int, single_line

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_sessions(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    limit = _parse_limit(args, default=100, maximum=100)
    if limit is None:
        return "Usage: /sessions [limit]"
    list_sessions = getattr(context.session, "list_recent_sessions", None)
    if not callable(list_sessions):
        return "Sessions are not supported by this session store."
    try:
        sessions = await list_sessions(limit=limit)
    except Exception as exc:
        return f"Command failed: {exc}"
    current_id = str(getattr(context.session, "session_id", "") or "")
    if not sessions:
        return SlashCommandResult(
            "No recent sessions.",
            display={
                "type": "sessions",
                "sessions": [],
                "current_session_id": current_id,
                "limit": limit,
                "resume_command": "/sessions",
            },
        )

    lines = ["Recent sessions:"]
    display_sessions = []
    for item in sessions[:limit]:
        if not isinstance(item, dict):
            continue
        session_id = display_value(item.get("id"))
        marker = " (current)" if current_id and session_id == current_id else ""
        updated = display_value(item.get("updated_at"))
        title = clip_text(display_value(item.get("title")), 40)
        size_data = item.get("size")
        size = _format_session_size(size_data)
        preview = clip_text(single_line(item.get("preview")), 56)
        suffix = f" | {preview}" if preview else ""
        lines.append(f"- {session_id}{marker} | {updated} | {title} | {size}{suffix}")
        display_sessions.append(
            {
                "id": session_id,
                "current": bool(current_id and session_id == current_id),
                "updated_at": updated,
                "title": display_value(item.get("title")),
                "messages": nonnegative_int(size_data.get("messages")) if isinstance(size_data, dict) else None,
                "tool_calls": nonnegative_int(size_data.get("tool_calls")) if isinstance(size_data, dict) else None,
                "preview": single_line(item.get("preview")),
            }
        )
    lines.append("Use /sessions to switch sessions.")
    return SlashCommandResult(
        "\n".join(lines),
        display={
            "type": "sessions",
            "sessions": display_sessions,
            "current_session_id": current_id,
            "limit": limit,
            "resume_command": "/sessions",
        },
    )


def _parse_limit(args: list[str], *, default: int, maximum: int) -> int | None:
    if not args:
        return default
    if len(args) != 1:
        return None
    try:
        limit = int(args[0])
    except ValueError:
        return None
    if limit <= 0:
        return None
    return min(limit, maximum)


def _format_session_size(value: object) -> str:
    if not isinstance(value, dict):
        return "unknown"
    messages = nonnegative_int(value.get("messages"))
    tools = nonnegative_int(value.get("tool_calls"))
    return f"{messages} msg, {tools} tool"


COMMAND = SlashCommandInfo(
    name="sessions",
    description="List recent sessions",
    usage="/sessions [limit]",
    handler=handle_sessions,
)
