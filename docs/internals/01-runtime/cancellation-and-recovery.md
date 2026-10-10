# Cancellation and recovery: stop the current action, keep the committed facts

English | [简体中文](cancellation-and-recovery.zh-CN.md)

Cancellation is not deleting history. It uses a token to interrupt model or tool reads, keeping already-persisted messages and task facts; recovery continues from the unclosed boundary instead of blindly redoing work.

~~~mermaid
flowchart TD
    C["session/cancel"] --> T["CancellationToken"]
    T --> M["Cancel the model's current read"]
    T --> X["Notify tools to wait"]
    M --> END["turn_cancelled persisted"]
    X --> END
    R["Resume a running turn"] --> P{"Any unclosed tool calls?"}
    P -->|"Yes"| D["Check committed results and complete them"]
    P -->|"No"| S["Rebuild the context"]
    D --> S
~~~

TurnRunner has a bounded step retry for stream_interrupted and persists the retry count; the tool processor reuses saved results by call ID, including failed results. If a call is missing its result during recovery, an explicit placeholder is written noting that it "may have executed or may not have", and it must not pretend to be exactly once. File threads under cancellation wait for already-started writes to finish; background processes need separate task cancellation or handling during Worker shutdown.

A user interruption suppresses automatic continuation and sets the active Goal to paused; a failure sets the active Goal to blocked. A normal Worker shutdown tries to terminate the processes it owns and wait for monitor tasks to end; force-killing an unresponsive Worker cannot guarantee that every child process has been cleaned up.

Code entry points: [the cancellation token](../../../agent/domain/cancellation.py), [TurnRunner](../../../agent/runtime/core/turn_runner.py), [the execution coordinator](../../../agent/runtime/server/execution.py). Verification: [cancellation tests](../../../test/test_cancellation_token.py), [task recovery](../../../test/test_task_continuation.py), [failure boundaries](../../../test/test_failure_boundaries.py).

[Back to the series map](../README.md)
