# Seeing the kernel: look for the fact layer first, then the transport layer

English | [简体中文](observability.zh-CN.md)

Content missing from the interface could mean the model never generated it, the Worker never committed it, the event never arrived, or simply that the Surface did not draw it. Rind's observability entry points cover these different stages; you cannot read the situation from the terminal's final screen alone.

~~~mermaid
flowchart LR
    C["Context assembly"] --> I["context inspect<br/>sources and token estimation"]
    C --> M["Model call"]
    M --> P["Messages / tool results / usage on disk"]
    P --> E["Runtime events"]
    E --> S["Surface state and rendering"]
    P --> R["History projection / replay"]
~~~

| Question to answer | Check first | Limits of the reading |
| --- | --- | --- |
| What inputs did the model actually see? | context inspect, context source labels | Local estimation is not the provider's measured input tokens |
| Did the tool really commit its result? | tool_calls.jsonl, message projection, task journal | UI start/delta events cannot stand in for the result facts |
| Why is text missing after a disconnect? | Session history, subscribing after_cursor, the current turn snapshot | The connection sequence and the history cursor are not the same number |
| Are tokens spent on answering or on compaction? | The call categories in usage.jsonl | The usage ledger does not compute monetary prices |

## A practical troubleshooting order

First locate the persisted records by session_id, turn_id, tool_call_id, or task_id, then look at subscribed events, `context inspect`, and the Surface. Startup and protocol diagnostics go to stderr; the stdio stdout must remain a valid protocol stream, and a single log line mixed in will break the consumer.

Source code: [context inspect dispatch](../../../runtime/src/server/dispatcher.ts), [startup diagnostics](../../../runtime/src/server/transports.ts). Verification: [context inspection](../../../runtime/test/server-protocol.test.js), [turn execution](../../../runtime/test/context-and-turn.test.js). Related: [events](../01-runtime/event-system.md), [usage ledger](../03-persistence/usage-ledger.md).

[Back to the series map](../README.md)
