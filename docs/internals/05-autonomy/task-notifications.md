# Automatic continuation: completion, delivery, and consumption are three separate things

English | [简体中文](task-notifications.zh-CN.md)

When a background command ends, its output must not be pushed straight into a tool conversation that has not yet closed. Rind first persists the process's terminal state, then confirms that the initial tool result has been committed, and finally delivers the notification at a safe boundary.

~~~mermaid
sequenceDiagram
    participant P as ProcessSupervisor
    participant J as TaskJournal
    participant T as ToolCallProcessor
    participant N as TaskNotifications
    participant R as TurnRunner
    par The process advances independently
        P->>J: Terminal state + stable event_id
    and Tool submission advances independently
        T->>J: Initial tool result committed: committed
    end
    N->>N: Tool call pairing closed?
    N->>R: Persist task_notification
    N->>J: delivered
    R->>R: Model successfully handled the context containing task references
    R->>J: consumed
~~~

A notification is eligible when it has an event_id, is committed, has been handed off, has notify=on_exit, is not yet delivered, and is not cancelled. The notification is persisted to disk as an internal user-role message with meta.kind=task_notification; the process facts are kept separate from untrusted_process_output, so output can never become a system instruction. The stable ID lets recovery find notifications whose message has already been written but has not yet been acknowledged.

delivered proves only that the notification has entered the session; consumed is marked after the model step succeeds. If the model fails, the unconsumed references and the continuation_error are kept. Compaction also copies active or unconsumed task references into the handoff, so long-running tasks are not erased by summarization.

An idle session is woken by the ExecutionCoordinator, and that session still runs only one turn. Interruption suppresses continuation, and so does a paused or blocked Goal. Once model retries are exhausted, automatic advancement stops and waits for new user input. Tasks already delivered through a terminal-state tool result do not receive a duplicate completion notification.

## Two race scenarios

**The process ends first; the tool result is committed later.** The terminal state can be recorded in the journal first, but without the committed qualification no notification is injected; otherwise a new user message would appear in the model context between the call and the result.

**The notification has been written; model sampling failed.** delivered already holds while consumed does not: the system keeps the references and the error instead of treating "delivered to the context" as "successfully handled". On the next recovery, the stable event_id identifies the original notification, and compaction also retains task references that have not yet been consumed.

This ordering reduces the risk of duplication and loss, but it does not promise that business actions execute exactly once globally. Whether an external process's side effects actually happened can still be uncertain at crash boundaries, and the task journal is honest about that with statuses such as lost.

Code entry points: [TaskNotifications](../../../agent/application/task_notifications.py), [continuation coordination](../../../agent/runtime/server/execution.py). Verification: [notification delivery](../../../test/test_task_delivery.py), [automatic continuation](../../../test/test_task_continuation.py).

[Back to the series map](../README.md)
