# Session creation, restoration, forking, and deletion: from draft to fork

English | [简体中文](session-lifecycle.zh-CN.md)

A session ID, an on-disk directory, and an active execution do not come into being at the same moment. Separating the three keeps startup, switching, and preview lightweight.

~~~mermaid
stateDiagram-v2
    [*] --> Draft: default startup keeps the id
    Draft --> Persisted: first user task or an explicit Goal
    [*] --> Persisted: session/new creates it explicitly
    Persisted --> Active: prompt / compact
    Active --> Persisted: turn terminal state, container released
    Persisted --> Forked: session/fork
    Persisted --> Deleted: session/delete
~~~

SessionService's default startup draft has a stable ID in memory and writes no directory, while session/new persists immediately, which makes cross-process routing possible. Listing sessions, switch, and replay do not require turning it into an active execution. Opening an existing session validates session_id, schema, workspace, and Team identity binding.

A fork takes a snapshot **before** the specified user message: it copies the retained messages, the related tool records, the valid compaction records, and the attachments, and generates a new ID and parent_session_id. Managed processes and task logs are not carried over by a fork, and the old processes are not adopted by the new session. Deleting a session first stops it from starting again, then stops its active execution and owned Shell tasks, and finally deletes the persistent directory and the index.

## What a fork preserves must be judged category by category

The history before the fork point and the related attachments are the new session's starting point; the selected user message is left for the Surface to re-edit, so this is not "fork after that message has run". Related tool records are copied by reference, but background-process ownership cannot be transferred just by copying JSON.

A fork's meta is derived from the original metadata, with fields such as identity rewritten, so one cannot broadly claim that state such as Goal and turn_state is cleared. If a caller needs new business state, it should inspect the concrete return value and metadata rather than inferring from the new session_id alone that it is a completely blank execution environment.

Code entry points: [SessionService](../../../runtime/src/server/session-service.ts), [fork implementation](../../../runtime/src/infrastructure/persistence/session-store.ts), [Worker deletion](../../../runtime/src/server/worker.ts). Verification: [startup session](../../../runtime/test/server-protocol.test.js), [fork](../../../runtime/test/server-protocol.test.js), [deletion](../../../runtime/test/server-protocol.test.js).

[Back to the series map](../README.md)
