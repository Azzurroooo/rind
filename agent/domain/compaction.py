"""Shared compaction boundary constants."""

COMPACT_CONTINUATION_USER_CONTENT = (
    "Continue from the compacted conversation state. "
    "Use the compact handoff below as the source of prior context."
)

COMPACT_HANDOFF_REASONING_CONTENT = (
    "Compacted context handoff: the summary in this message replaces prior history; "
    "no separate reasoning trace exists for this boundary."
)
