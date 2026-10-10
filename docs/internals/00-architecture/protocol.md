# One protocol: requests close, events advance

English | [简体中文](protocol.zh-CN.md)

The protocol version is 2. Each call carries a request_id that maps to one response, while ongoing changes are sent as independent session/update events. The two channels solve different problems and cannot replace each other.

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant D as RuntimeDispatcher
    participant R as Runtime
    S->>D: request(request_id, session/prompt)
    D->>R: start turn
    R-->>D: RuntimeEvent
    D-->>S: event(session/update, sequence, durability)
    R-->>D: turn ended
    D-->>S: response(request_id, result)
~~~

initialize publishes protocol_version, methods, capabilities, the current session, and the command catalog. Common methods such as session/prompt, session/replay, and model/set use stable names, while product extensions live in the rind/ namespace and are invoked through capability discovery. Event envelopes uniformly carry session_id, turn_id, sequence, and durability, with the concrete type in event.type.

durable marks key progress that can be rebuilt from session facts, such as turn start/end and tool results; incremental covers what needs immediate display, such as streaming text. The persistent history cursor and cross-turn task events are not the same counter. After a disconnect, the client replays history and then fills in the current state from task and live-turn snapshots.

## A minimal request and two different confirmations

~~~json
{"kind":"request","request_id":"r-1","method":"session/prompt","params":{"session_id":"session-1","input":"Explain the current change"}}
~~~

request_id is the call correlation identifier, session_id selects the persistent session, turn_id identifies the execution turn, and event_id identifies a concrete event. They are not interchangeable "task numbers". The sequence on a connection serves event-stream order and cannot be used directly as after_cursor.

A normal prompt's response returns after the turn ends; a one-shot that supports request scope also waits for this run's task continuation. Queue methods, on the other hand, confirm only receipt in accepted, and actual delivery is announced by queued_input_delivered. A client should judge completion from the invocation contract, and must not present any response as "work completed".

Code entry points: [Python protocol](../../../agent/runtime/server/protocol.py), [Dispatcher](../../../agent/runtime/server/dispatcher.py), [CLI mirror](../../../frontend-cli/lib/runtime-protocol.js). Verification: [protocol regression](../../../test/test_runtime_server_protocol.py), [golden fixture](../../../test/fixtures/runtime_protocol.golden.jsonl).

[Back to the series map](../README.md)
