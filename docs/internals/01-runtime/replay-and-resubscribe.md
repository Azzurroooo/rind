# Replay: history, the active tail, and task snapshots each do their part

English | [简体中文](replay-and-resubscribe.zh-CN.md)

Reconnecting after a disconnect cannot just replay text: saved messages, a turn that is still running, and background tasks spanning turns come from different sources.

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant W as RuntimeWorker
    participant D as SessionStore
    participant E as ExecutionCoordinator
    participant T as ShellTools
    S->>W: session/replay(after_cursor)
    W->>D: project history messages or durable events
    W->>E: the current live_turn
    W->>T: the current tasks snapshot
    W-->>S: history + live_turn + tasks + background_wait
~~~

A regular replay reads persisted messages and turn_state, and attaches a bounded live_turn overlay; it does not start an Agent. Event pagination mode rebuilds durable events from messages, tool records, and terminal states. after_cursor counts only the conversation's durable sequence; task updates do not crowd that cursor. When the client applies a task snapshot, it should replace the old state, so a completion event missed during the disconnect is not lost.

live_turn exists only in a Worker that is still alive, letting the interface restore the text tail, tool states, or a pending question that has not been persisted yet; after a Worker restart, only the on-disk facts can be relied on. Switching sessions or replaying must not re-execute tools.

## Recovery restores a view, it does not retry network requests

Before the disconnect, a stretch of assistant_delta was already displayed; after the disconnect, two cases are possible: if the assistant message has been fully committed, it is rebuilt from the persisted history; if sampling is still in progress, live_turn is also needed to provide the current tail. Replaying durable events alone misses the latter, while keeping only the old client buffer may miss commits made during the disconnect.

Tasks use a separate snapshot because a process can span multiple turns. after_cursor does not count the task snapshot, and the client should not miscount a single snapshot application as a new conversation event. After a Worker restart there is no old live tail; recovery should honestly show the on-disk boundary rather than padding a half-finished stream into a complete answer.

Code entry points: [Worker.replay](../../../agent/runtime/server/worker.py), [the durable projection](../../../agent/runtime/server/replay_events.py), [Dispatcher replay](../../../agent/runtime/server/dispatcher.py). Verification: [protocol replay](../../../test/test_runtime_server_protocol.py), [session recovery preview](../../../test/test_resume_preview.py).

[Back to the series map](../README.md)
