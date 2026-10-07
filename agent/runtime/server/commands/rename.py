"""Name a conversation; without a name it is shown by its first message."""

from __future__ import annotations

from agent.infrastructure.persistence.session_meta import display_title
from agent.runtime.server.commands.contracts import SlashCommandContext, SlashCommandInfo, SlashCommandResult

USAGE = "/rename <name> · /rename --reset"
RESET = "--reset"


async def handle_rename(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    # The name is the rest of the line as typed (see raw_args below).
    text = args[0].strip() if args else ""
    session = context.session
    if not text:
        meta = await session.get_metadata()
        current = display_title(meta) or "(no title yet)"
        source = "its name" if meta.get("name") else "its first message"
        return f"Shown as: {current} ({source}).\nUsage: {USAGE}"
    try:
        result = await session.set_name(None if text == RESET else text)
    except ValueError as exc:
        return f"{exc} Usage: {USAGE}"
    session_id = str(getattr(session, "session_id", "") or "")
    message = f"Named: {result['name']}" if result["name"] else f"Name cleared; shown as: {result['title'] or '(no title yet)'}"
    return SlashCommandResult(message, display={"type": "session_renamed", "session_id": session_id, "name": result["name"], "title": result["title"]})


COMMAND = SlashCommandInfo(
    name="rename",
    description="Name this conversation (otherwise it is shown by its first message)",
    usage=USAGE,
    handler=handle_rename,
    raw_args=True,
)
