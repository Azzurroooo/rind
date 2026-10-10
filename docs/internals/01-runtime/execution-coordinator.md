# Each session has only one execution channel

English | [简体中文](execution-coordinator.zh-CN.md)

A user turn, a continuation after a background task finishes, and Goal checkpoints can all require the model. The ExecutionCoordinator funnels them into the same per-session execution position, preventing two turns from rewriting the same stretch of history at the same time.

~~~mermaid
flowchart TB
    U["User input"] --> Q["Session execution entry"]
    T["Task completion wake-up"] --> Q
    G["Goal checkpoint"] --> Q
    Q --> L["Wait for the session's turn_slot"]
    L --> CHECK{"Re-check eligibility after taking the slot"}
    CHECK -->|"Lost eligibility / user has priority"| SKIP["Yield this automatic continuation"]
    CHECK -->|"Executable"| A["AgentContainer.run_turn"]
    A --> P[("Commit message and turn state")]
    A --> R["Idle release"]
~~~

The coordinator maintains active containers, pending wake-ups, and request scopes. After taking the session's execution position, it re-checks eligibility: if the Goal is paused or blocked, task notifications have not been committed yet, or the session has been deleted, a turn must not start merely because an earlier wake-up arrived. Creating the model client and reading from disk happen outside the global coordination lock, so one slow session cannot hold up all sessions.

One session executes only one turn at a time; other sessions can run in parallel. A continuation is not an extra Agent spawned out of thin air: it calls the same run_turn path, so it gets the same events, persistence, cancellation, and error handling.

## Three kinds of requests arriving at the same moment

User input, task completion notifications, and Goal checkpoints can all arrive at once. The coordinator first contends for the session's turn_slot; even after an automatic continuation takes the position, it must still check queued_turn_starts, the suppression marker, pending notified tasks, and the latest Goal status. When another start is already queued, the continuation can simply yield; it must not treat an earlier wake-up as a command that has to be executed.

A manual compact also needs the exclusive position; if a turn is already active or a start is queued, compaction is rejected rather than rewriting the context in parallel. An explicit user business input can lift the suppression after an interruption; a maintenance compact keeps the suppression marker. This distinction prevents a user who only wants to tidy up the context from accidentally restarting a long-running goal that has already stopped.

Code entry points: [ExecutionCoordinator](../../../agent/runtime/server/execution.py), [AgentRuntime](../../../agent/runtime/core/runtime.py). Verification: [automatic continuation](../../../test/test_task_continuation.py), [runtime input queues](../../../test/test_runtime_input_queues.py).

[Back to the series map](../README.md)
