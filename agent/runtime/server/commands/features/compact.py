"""Context compaction slash command."""

from agent.runtime.server.commands.formatting import display_value

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_compact(context: SlashCommandContext, args: list[str]) -> SlashCommandResult | str:
    compact_context = getattr(context.runtime, "compact_context", None)
    if not callable(compact_context):
        return "Compact is not supported by this runtime."
    if getattr(context.runtime, "turn_active", False):
        return "Cannot compact while a turn is running. Wait for it to finish or interrupt it first."
    if not await _has_compactable_conversation(context.session):
        return "Not enough messages to compact. Send a message first."
    record = await compact_context(reason="manual")
    source = record.get("source") if isinstance(record, dict) else {}
    if not isinstance(source, dict):
        source = {}
    start = source.get("message_start_index", "?")
    end = source.get("message_end_index_exclusive", "?")
    tool_count = len(source.get("tool_call_ids") or [])
    return SlashCommandResult(
        "\n".join(
            [
                "Compact complete.",
                f"- id: {display_value(record.get('id') if isinstance(record, dict) else None)}",
                f"- source: messages[{start}:{end}]",
                f"- tool calls: {tool_count}",
            ]
        ),
    )


async def _has_compactable_conversation(session) -> bool:
    get_messages = getattr(session, "get_messages_slice", None)
    if not callable(get_messages):
        return True
    messages = await get_messages()
    return any(
        isinstance(message, dict) and message.get("role") != "system"
        for message in messages
    )


COMMAND = SlashCommandInfo(
    name="compact",
    description="Compact current session context",
    usage="/compact",
    handler=handle_compact,
)
