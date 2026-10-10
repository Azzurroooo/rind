# A bounded system: exits where data is amplified

English | [简体中文](limits-and-backpressure.zh-CN.md)

Low resident load is carried by on-demand containers, peak load by local bounds. The model stream, input queues, tool results, and process output use different strategies: wait where waiting is needed, truncate where truncation is needed, and fail explicitly where input must be rejected.

~~~mermaid
flowchart TB
    M["Model stream"] --> Q["256 events / 1 MiB<br/>wait when full"]
    Q --> C["Text batching<br/>25ms / 8KiB"]
    C --> T["CLI stdout<br/>write=false waits for drain"]
    P["Shell output"] --> D["Disk quota<br/>32MiB including the index"]
    D --> R["Paginated reads / bounded results"]
    R --> X["ContextManager<br/>budget / compaction"]
    X --> M
~~~

| Location | Current bound or default | Behavior at the boundary |
| --- | --- | --- |
| Model stream event queue | 256 events, 1 MiB; a single event may not exceed 1 MiB | Producers wait for space; an oversized single event raises an error |
| Text and tool argument deltas | At most 2,048 characters per piece | Bounds the size of one event without dropping content |
| steering / follow-up | 4 items per queue, 8,000 characters in total | Rejects new input and keeps the existing queues |
| Tool projection | terminal 8 KiB; model 25 KiB / 2,000 lines | Normalization and truncation; the full output is read per the contract |
| Shell supervisor | 8 not-yet-retired task records by default | Rejects new tasks once capacity is reached |
| Process output to disk | 32 MiB by default, including the index | Records the over-limit information, keeps draining, and discards output beyond the bound |
| Ordinary file read | At most 50 KiB of source content per call | Paginates; different from the model projection bound |
| Images | 20 MiB / 40 million pixels per source; 3 MiB after normalization | Rejected or scaled; a request is separately limited to 8 images / 16 MiB of encoded data |

These values are in different units: characters, UTF-8 bytes, lines, and tokens are not interchangeable, and a 2,048-character CJK text can be far larger than 2 KiB. The defaults in the table are also not a total memory bound for the whole machine.

## Why there cannot be a single master switch

If reading from the child process pipe stopped as soon as output exceeded the limit, the child could stall because the pipe filled up, so the supervisor keeps draining. If "cancellation" were also pushed into an already full event queue, the cancellation would wait for consumption; the stream pump therefore uses out-of-queue task cancellation and completion wakeups to remove that dependency.

Likewise, low load does not mean every cache is cleared: the Worker still holds managed tasks, bounded session/task caches, and connections, and the on-disk task journal needs maintenance to shrink. Bounds should be analyzed from the resource owner and the retirement conditions, not from a single array length.

Source code: [stream backpressure](../../../agent/runtime/core/stream_pump.py), [CLI drain](../../../frontend-cli/lib/tui/tui.js). Mechanisms and test entry points: [input queues](../01-runtime/input-queues.md), [structured results](../04-tools/tool-results.md), [managed tasks](../05-autonomy/managed-tasks.md), [images](../02-context/image-input.md). Verification: [stream pump](../../../test/test_stream_pump.py), [runtime stream](../../../test/test_runtime_stream_pump.py).

[Back to the series map](../README.md)
