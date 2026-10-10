# The event system: turning execution facts into interface updates

English | [简体中文](event-system.zh-CN.md)

The kernel produces RuntimeEvents; the protocol layer only wraps them uniformly. Interfaces subscribe to "what happened" instead of reading Python objects or polling the session file again and again.

~~~mermaid
flowchart LR
    RUN["TurnRunner / ToolProcessor"] --> EV["domain RuntimeEvent"]
    TASK["Task observer"] --> EV
    EV --> DISP["RuntimeDispatcher"]
    DISP --> ENV["session/update<br/>sequence · durability · session_id · turn_id"]
    ENV --> UI["CLI / Desktop / Web / Gateway"]
    STORE[("Messages and tool records")] --> REPLAY["Durable event rebuild"]
    REPLAY --> ENV
~~~

Incremental events such as assistant_delta, tool_input_delta, and tool_progress are for immediate display; turn_started, assistant_message_completed, tool_requested, tool_result, and terminal states belong to the durable class. Task updates arrive across turns with an empty turn_id and the original origin_turn_id, and they do not reactivate an old turn. The Dispatcher maintains a sequence per connection and sends session events only to connections that have subscribed.

Events are not a second persistence database. The session saves messages, tool records, and turn state; on reconnect, durable events are projected from these facts. This distinction lets the real-time interface be rich while the on-disk model stays simple.

## Similar names, three different roles

| Field or classification | The problem it solves | What it cannot replace |
| --- | --- | --- |
| sequence | The send order of events on the current connection | The conversation's durable cursor |
| event_id | The identity of a single event; a task completion notification can be deduplicated with a stable ID | The session or turn ID |
| durability | Whether it counts as recoverable key progress | Proof that every event is written to a separate event file |

For example, after a tool request is sent, the interface can expand the tool block immediately, but the real completion shows in tool_result and the persisted record. A Task's terminal state can also arrive after its original turn ends, so it keeps the source turn rather than marking an already finished turn as running again. Event wrapping is uniform; the business lifetime is still decided by the event type.

Code entry points: [event types](../../../agent/domain/events.py), [the protocol wrapper](../../../agent/runtime/server/protocol.py), [the replay projection](../../../agent/runtime/server/replay_events.py). Verification: [event tests](../../../test/test_runtime_events.py), [subscription tests](../../../test/test_runtime_server_subscriptions.py).

[Back to the series map](../README.md)
