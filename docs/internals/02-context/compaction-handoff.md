# Compaction handoff: replace the model view, do not destroy the original history

English | [简体中文](compaction-handoff.zh-CN.md)

The key to compaction is not "writing a summary" but forming a boundary that lets the tool loop continue: the old history becomes a handoff, while the most recent stretch of conversation stays behind as-is.

~~~mermaid
flowchart LR
    RAW["Original messages<br/>old history + recent messages"] --> CUT{"Split by conversation unit"}
    CUT --> OLD["History to summarize"]
    CUT --> RECENT["Recent messages kept as-is"]
    OLD --> SUMMARY["Model summary / deterministic fallback"]
    SUMMARY --> PAIR["user continuation message + assistant handoff"]
    PAIR --> VIEW["New model view"]
    RECENT --> VIEW
    RAW --> DISK[("Original JSONL retained")]
~~~

The split unit must not break apart an assistant tool_calls and its corresponding tool results. The summary request keeps history and retained_recent_messages separate, retaining the latter for reference without duplicating it in the handoff. The budget precheck only shortens over-long tool bodies; it never deletes user text or tool arguments. If the input still does not fit, the commit is rejected. Cancellation is also rechecked after the model returns but before the commit.

Both successful handoffs and the deterministic fallback record their strategy. An empty summary or a non-success finish reason cannot be treated as a complete handoff, and Provider usage is recorded even when the summary is discarded. On disk, compactions.jsonl and compact_boundary are written, and the next projection replaces the old context with "user continuation message + assistant handoff + recent messages" and validates the message boundary; the original history remains usable for replay.

## The summary itself must fit in the window

The summary request reserves an output budget of min(8,192, window/10) and then leaves 5% of the window as headroom. Over-long tool bodies can be compressed to their first 2,000 characters and last 2,000 characters, with the omitted amount marked in between; user constraints and tool arguments are exempt from this shortening. If the precheck still does not fit, it fails: you cannot cut out user requirements first and then declare the compaction a success.

| Compaction artifact | Purpose |
| --- | --- |
| Continuation user + assistant handoff | Establish the message boundary from which the conversation can continue |
| Most recent complete conversation units | Preserve the near-field details of tool calls and results |
| Plan snapshot, active/unconsumed task references | Restore TODOs and background work from the current control state |
| Image snapshot paths | Tell the next model where to re-read the evidence |

The summary model's reasoning is not retained as new business reasoning history; when it is projected into a handoff, a fixed non-empty reasoning marker is used to satisfy the corresponding compatibility requirement. Compaction records and boundary messages are persisted separately, and only matching valid pairs are adopted; this is not a cross-file ACID transaction. See [session structure](../03-persistence/session-store.md) for details.

Code entry points: [compaction service](../../../agent/application/context/compaction.py), [handoff construction](../../../agent/application/context/handoff.py), [projection](../../../agent/infrastructure/persistence/message_projector.py). Verification: [compaction service](../../../test/test_compaction_service.py), [boundary recovery](../../../test/test_compact_pipeline.py).

[Back to the series map](../README.md)
