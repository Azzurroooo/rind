# Low load comes from clear resource ownership

English | [简体中文](resource-ownership.zh-CN.md)

"Stateless" applies only to where persistent sessions are stored: history lives on disk, while Worker memory still owns the running processes, queues, and cancellation. What truly saves resources is that execution objects exist only on demand.

~~~mermaid
flowchart TB
    subgraph W["Worker lifetime"]
        SS["SessionService"]
        SH["Shared parsing / normalization / compaction"]
        SHELL["ShellTools + ProcessSupervisor"]
    end
    subgraph A["Active session execution lifetime"]
        AC["AgentContainer"]
        RT["AgentRuntime"]
        MC["Model client"]
        AC --> RT
        AC --> MC
    end
    SS --> DISK[("JSONL: durable facts")]
    SHELL --> JOURNAL[("Task journal")]
    W -->|"created only when there is work"| A
    A -->|"idle release"| W
~~~

The ExecutionCoordinator keeps containers only for active sessions; once the turn completes and no work is queued, it closes the model client and the container. ShellTools is owned solely by the Worker: after a bash task is handed off to the background, the turn container can be released while the process and the task journal remain under the same Worker's management. The next continuation reassembles the execution from the latest session settings.

The shared services hold no long-lived, per-session mutable state; a session's messages, tool calls, and goal are re-read from SessionStore. Multiple sessions can be active at the same time, but each session's turns still run serially. This ownership split avoids both "one resident Agent per session" and "mistakenly killing background tasks when releasing a container".

## Testing ownership with one long command

Suppose bash is still running when its wait window expires: the tool returns a task_id, and the model temporarily ends the turn. The ExecutionCoordinator can release the container and the model connection while ProcessSupervisor keeps collecting the command's output; when the command finishes, the notification system wakes the session again and a new container is created to read the durable context.

| Action | Should release | Should keep |
| --- | --- | --- |
| Turn idle | The active container and its model client | Session files and Worker-owned managed processes |
| Client disconnects the WebSocket | That connection and its subscriptions | The Worker and its still-running executions |
| Worker shutdown | Active executions, shared connections, and the processes it owns | Durable sessions and terminal-state records |

So "low load" comes from separating lifetimes, not from making every resource stateless. Shared services also do not mean sharing a single model client that never closes; that belongs to the active container.

Code entry points: [Worker](../../../agent/runtime/server/worker.py), [the execution coordinator](../../../agent/runtime/server/execution.py), [the composition root](../../../agent/bootstrap/container.py). Verification: [idle release tests](../../../test/test_runtime_worker.py), [Shell lifecycle](../../../test/test_worker_shell_lifecycle.py).

[Back to the series map](../README.md)
