# Goal: preserving "not done yet" across turns

English | [简体中文](goals.zh-CN.md)

A Goal is the objective and status recorded in the session meta. A turn ending only means that this round of execution has stopped; it does not mean the user's objective has been achieved. An active Goal can schedule new checkpoints to carry on.

~~~mermaid
stateDiagram-v2
    [*] --> Active: User sets the objective
    Active --> Active: Turn ends, checkpoint continues
    Active --> Paused: User pause or turn cancellation
    Active --> Blocked: Model marks blocked or turn failure
    Active --> Complete: update_goal complete
    Paused --> Active: User resumes
    Blocked --> Active: User resumes
    Complete --> [*]: Cleared or finished
~~~

The objective text is limited to 4,000 characters. The protocol provides get, set, status, and clear; the model tool update_goal can only set complete or blocked, and it cannot create a goal on its own. The policy prompt requires checking the objective item by item before declaring completion, but the kernel does not automatically prove business outcomes; it guarantees the state machine and the scheduling boundaries.

The coordinator handles pending task notifications first. While on_exit background tasks are still awaiting completion, it does not spin on repeated Goal checkpoints. When there are no pending notifications, no waiting tasks, and the Goal is still active, it writes an internal goal_checkpoint and executes it through an ordinary run_turn. Failures and interruptions suppress continuation, and a manual compact must not restart a goal that has already stopped.

The current public Goal model has only active, paused, blocked, and complete, with no token_budget field and no settable budget_exhausted status. A defensive check by that name exists in the coordinator, but it must not be used to claim in documentation that the Goal budget feature has been implemented.

## How Goal, Plan, and background tasks work together

A Plan holds the current step, a Goal the overall objective, and a Task the real process state. The three are not interchangeable: marking every step completed does not prove the Goal is complete; an active Goal does not let the model ignore tests that are still running; and a test exiting successfully is only a fact, which the model must judge against the objective.

For example, given the objective "fix and verify", the model may end the current turn once it has started the tests. If an on_exit test task remains, the coordinator waits for the notification instead of repeatedly sending "continue"; once the test's terminal state arrives, it runs an ordinary turn, and the model either fixes the issue or calls update_goal based on the result. The saved busy-waiting comes from these gating conditions, not from forcing the model to keep a single long connection alive forever.

Code entry points: [Goal model](../../../agent/domain/goal.py), [Goal tool](../../../agent/infrastructure/tools/goal.py), [checkpoint prompt](../../../agent/prompts.py), [scheduling](../../../agent/runtime/server/execution.py). Verification: [runtime flow](../../../test/test_async_runtime.py), [continuation and Goal](../../../test/test_task_continuation.py).

[Back to the series map](../README.md)
