# Seeing the kernel: look for the fact layer first, then the transport layer

English | [简体中文](observability.zh-CN.md)

Content missing from the interface could mean the model never generated it, the Worker never committed it, the event never arrived, or simply that the Surface did not draw it. Rind's observability entry points cover these different stages; you cannot read the situation from the terminal's final screen alone.

~~~mermaid
flowchart LR
    C["Context assembly"] --> I["context inspect<br/>sources and token estimation"]
    C --> M["Model call"]
    M --> L["Raw Chat trace (explicitly enabled)"]
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
| What did the SDK return? | The raw LLM trace, once enabled | Currently only the OpenAI Chat adapter calls make_trace |

## The trace's precision comes from being close to the provider

After `RIND_TRACE_LLM=1` or a startup with `--trace-llm`, every hooked call writes a JSONL file under RIND_HOME/sessions/session_id/_llm_trace: request, raw response chunk, end. Records flush line by line, so a mid-way failure can still leave material for locating the problem; when no session_id has been obtained yet, no trace is created.

The trace is recorded before the model stream enters the kernel's parsing, which makes it suitable for distinguishing "the provider did not send the tool call" from "parsing/presentation dropped it". It omits image bytes, base64, and data URL content, but ordinary prompts and responses are kept. Do not write this feature up as end-to-end tracing available in every adapter.

## A practical troubleshooting order

First locate the persisted records by session_id, turn_id, tool_call_id, or task_id, then look at subscribed events and the Surface. Enable the trace to reproduce the problem only when it really lies at the model boundary. Startup and protocol diagnostics go to stderr; the stdio stdout must remain a valid protocol stream, and a single log line mixed in will break the consumer.

Source code: [context inspect dispatch](../../../agent/runtime/server/dispatcher.py), [trace](../../../agent/infrastructure/llm/trace.py), [Chat hook point](../../../agent/infrastructure/llm/openai_chat.py), [startup diagnostics](../../../agent/runtime/server/app_server.py). Verification: [context inspection](../../../test/test_runtime_server_context.py), [trace](../../../test/test_llm_trace.py). Related: [events](../01-runtime/event-system.md), [usage ledger](../03-persistence/usage-ledger.md).

[Back to the series map](../README.md)
