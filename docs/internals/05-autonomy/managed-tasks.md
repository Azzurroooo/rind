# Managed tasks: the command, the wait, and the notification each have their own state

English | [简体中文](managed-tasks.zh-CN.md)

A command can still be running after the tool call that started it has already returned. Rind tracks the process itself with task_id, handoff records whether it has been moved to the background, and notify decides how to continue once it ends.

~~~mermaid
stateDiagram-v2
    [*] --> Starting: Persist the startup intent first
    Starting --> Running: Startup succeeded
    Starting --> Failed: Startup failed
    Running --> Running: Wait timeout or release_wait hands back control
    Running --> Completed: Exit code is 0
    Running --> Failed: Non-zero exit or execution error
    Running --> Cancelled: Explicit cancellation
    Running --> TimedOut: Run deadline reached
    Running --> Lost: Confirmable process ownership lost
~~~

| Control | What it changes | What it does not mean |
| --- | --- | --- |
| yield_time_ms | The wait window for the first tool call | The process run deadline |
| timeout_ms | How long the command may run | The model request timeout |
| task_control read / wait | View output or a bounded wait | Claim and remove output |
| rind/task/release_wait | Release the current wait early | Terminate the process |
| task_control cancel | Terminate the owned process tree | Delete historical task records |

notify=on_exit is for commands whose results still need handling after they end; notify=manual suits services and watchers, which must check readiness themselves and cannot treat a still-running process as proof that the service is available. The UI's background_wait counts only the on_exit tasks the current Worker has committed and handed to the background, and is bounded by interruption, Goal, and request scope; it is not a count of "all background processes".

ProcessSupervisor keeps at most 8 managed-process records by default; once a process ends, eligible records are retired, while the durable facts remain in the journal. Task monitoring runs separately from the model turn, so output and the terminal state can still arrive while the model is idle.

Code entry points: [supervisor](../../../agent/infrastructure/tools/shell/supervisor.py), [task state](../../../agent/domain/tasks.py), [background_wait](../../../agent/runtime/server/execution.py). Verification: [Shell tasks](../../../test/test_shell_tasks.py), [background wait](../../../test/test_bash_background_wait.py).

[Back to the series map](../README.md)
