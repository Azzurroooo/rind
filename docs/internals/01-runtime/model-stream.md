# The model stream: bounded buffering, preserved order

English | [简体中文](model-stream.zh-CN.md)

A Provider SDK's stream does not go directly to a Surface. TurnRunner first converts it into unified events, and the stream pump then uses a bounded queue to decouple the model's read speed from downstream consumption.

~~~mermaid
flowchart LR
    SDK["Provider async stream"] --> PARSER["MessageStreamParser"]
    PARSER --> PRODUCER["Text / tool arguments / usage events"]
    PRODUCER --> Q["Bounded queue<br/>256 events · 1 MiB"]
    Q --> BATCH["Batch adjacent text<br/>25 ms or 8 KiB"]
    BATCH --> R["RuntimeEvent"]
    R --> SURFACE["Surface"]
~~~

stream_pump.py splits text and tool arguments at character boundaries, and the queue bounds both the item count and the serialized byte count; an oversized non-text event fails explicitly. Adjacent assistant text waits at most 25 ms or accumulates up to 8 KiB; tool arguments, usage, and termination boundaries are never reordered. When the consumer is slow, the producer waits for space rather than piling up events without limit.

Cancellation interrupts the model stream as it is being read; the end of production and cancellation are signaled to the consumer with separate wake-up signals, not by stuffing an end marker into a queue that is already full. The parser collects the complete text, tool calls, reasoning, and finish reason, and the usage record is written only after usage has been normalized.

## Batching only changes delivery granularity, not business boundaries

Suppose the model emits text A, then B, followed by a tool-argument fragment: A/B can be combined into one assistant_delta, but the tool event must keep its original position, and batching must not cross it to keep concatenating the text that follows. The parser still accumulates tool arguments by call ID, and only a complete call reaches argument validation and execution.

This queue bounds the events waiting to be forwarded; it does not mean the complete answer or the SDK's internal buffer is limited to 1 MiB as well. When the consumer stops, cancellation occurs, or parsing fails, the underlying stream must be closed and the reading task ended; otherwise a "bounded queue" can still leave live network resources behind. Related tests must check order, backpressure, and cleanup together.

Code entry points: [the stream pump](../../../agent/runtime/core/stream_pump.py), [the parser](../../../agent/runtime/core/stream_parser.py). Verification: [stream pump bounds](../../../test/test_stream_pump.py), [message parsing](../../../test/test_message_stream_parser.py).

[Back to the series map](../README.md)
