# Steering and follow-up are two queues

English | [简体中文](input-queues.zh-CN.md)

steering must influence the turn in progress; follow-up waits for the previous task to reach a safe boundary. Both are accepted first and only then actually delivered by the execution loop.

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant R as AgentRuntime
    participant T as TurnRunner
    S->>R: steer(text) or follow_up(text)
    R-->>S: accepted + input_id + pending
    alt steering
        T->>R: take one before the next sampling
        R-->>T: FIFO steering
    else follow-up
        R->>R: take one after the previous sampling ends
    end
    R-->>S: queued_input_delivered(input_id)
~~~

Each queue holds at most 4 items and a combined total of 8,000 characters. Normal consumption follows FIFO; a retraction without an input_id takes back the most recent item, while a specified ID takes back the corresponding undelivered item. accepted only means the input entered the queue; queued_input_delivered means it has been written into the turn. A Surface must not treat it as a sent user message ahead of time.

Compaction, tool calls, and cancellation also respect this boundary: new steering does not rewrite the current summary request; a tool call/result must be closed before an input is inserted; cancellation clears the still-pending queues.

## Retraction and promotion change the pending items

Two inputs, A and B, wait in order in the same queue: normal delivery sends A first, then B; a retraction without an input_id takes back the latest B, restoring what the user just wrote to the input box. A specified ID locates that exact item. An input that has already been delivered becomes a persisted message and no longer belongs to the retractable queue.

A follow-up can be promoted to steering, changing "do it after completion" into "seen before the next sampling". Promotion does not cancel the model HTTP request in flight; it changes when the next safe delivery happens. A Surface should keep input_id to align acceptance, retraction, and delivery, so the same text does not appear twice in the queue panel and in the sent history.

Code entry points: [the input queues](../../../agent/runtime/core/runtime.py), [the execution entry point](../../../agent/runtime/server/execution.py). Verification: [queue regression](../../../test/test_runtime_input_queues.py), [the compaction input flow](../../../test/test_compact_input_lifecycle.py).

[Back to the series map](../README.md)
