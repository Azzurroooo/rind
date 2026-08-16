"""Context compaction slash command."""

from agent.runtime.server.commands.formatting import display_value

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_compact(context: SlashCommandContext, args: list[str]) -> SlashCommandResult | str:
    compact_context = getattr(context.runtime, "compact_context", None)
    if not callable(compact_context):
        return "Compact is not supported by this runtime."
    record = await compact_context(reason="manual", cancellation_token=context.cancellation_token)
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


COMMAND = SlashCommandInfo(
    name="compact",
    description="Compact current session context",
    usage="/compact",
    handler=handle_compact,
)
