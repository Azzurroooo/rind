# Background task logs: a ledger of facts for background processes

English | [简体中文](task-journal.zh-CN.md)

A managed Shell process may outlive the model turn, so once it is handed off to the background (`handoff=true`), its state cannot live only inside AgentContainer. Foreground commands that finish inline leave no task journal entries; `TaskJournal` records process facts and origin identity in a per-session `tasks.jsonl` only when a running command promotes to the background.

~~~mermaid
flowchart LR
    START["bash promotes to background (handoff=true)"] --> J[("tasks.jsonl")]
    J --> RUN["running / output updated"]
    RUN --> J
    J --> TERM["completed / failed / cancelled / timed_out / lost"]
    TERM --> J
    RESTART["new Worker"] --> LEASE{"is the old Worker's lease still alive?"}
    LEASE -->|"no; state unknown"| LOST["recorded as lost; the command is not re-run"]
    LOST --> J
~~~

The Worker lease prevents another live Worker from adopting or signaling a process that is not its own. Promotion is deduplicated by session_id and origin_tool_call_id; when a restart cannot confirm process ownership, a lost status is appended instead of quietly running the command again. The terminal state is committed together with a stable event_id, so the notification system can resume delivery.

The task cache is bounded, and the journal remains the authoritative source for background tasks. Maintenance may clean up old consumed output while keeping the task facts and the deduplication identity; therefore "appending facts" does not mean output files are never reorganized. A corrupt section in the middle of the journal causes it to refuse to proceed; only an incomplete trailing record can be repaired at its boundary.

## Why background task identity has to stay for a long time

Once a command yields to the background, its record is persisted to `tasks.jsonl` before returning control to the turn: if the Worker crashes afterward while the background process is running, a new Worker can see that this `origin_tool_call_id` was handed off. Because ownership of the old OS process can no longer be confirmed, `lost` expresses the uncertainty, the deduplication identity is kept, and a retry avoids producing duplicate side effects.

The terminal state, notification delivery, and notification consumption are also separate steps. The journal keeps enough information for a recoverer to distinguish "the process ended", "the message entered the session", and "the model has seen it". Old output can be deleted once the maintenance conditions are met, yet the task identity and result status are still used to explain history.

Code entry points: [TaskJournal](../../../runtime/src/infrastructure/persistence/task-journal.ts), [ProcessSupervisor](../../../runtime/src/infrastructure/tools/shell-tools.ts). Verification: [task journal](../../../runtime/test/persistence.test.js), [journal index](../../../runtime/test/persistence.test.js).

[Back to the series map](../README.md)
