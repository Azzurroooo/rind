# The life of a Worker

English | [简体中文](worker-lifecycle.zh-CN.md)

A Worker is a long-lived protocol server, not a session object that permanently occupies a model client. Initialization can read session and model information; the AgentContainer is assembled only when real execution happens.

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant W as RuntimeWorker
    participant SS as SessionService
    participant EC as ExecutionCoordinator
    S->>W: initialize
    W->>SS: resolve the existing session or keep the startup draft
    W-->>S: session_id / methods / capabilities
    S->>W: session/prompt
    W->>EC: start(session_id)
    EC->>EC: assemble the active container
    EC-->>W: release the container once the turn ends
    S->>W: shutdown
    W->>W: stop accepting work and close owned resources
~~~

[RuntimeWorker](../../../agent/runtime/server/worker.py) creates SessionService, ExecutionCoordinator, the shared parsing/normalization/compaction services, ShellTools, and WebSessions. Only the first initialize starts a single refresh of the stale model catalog; on shutdown it cancels and awaits the refresh task, then closes active executions and Shell processes, and finally closes Web sessions.

A stable session_id is retained at startup, but the default draft does not need a session directory right away: only the first user task or an explicit Goal persists it to disk. Browsing the session list, models, status, and replay does not create an active AgentContainer. This way "opening the app" is not the same as "starting an Agent turn".

## Initialization can repeat, but side effects must not start twice

initialize uses a lock to guard the one-time setup: it cleans up tool output, decides the initial session, sets the initialized flag, and then starts the background catalog refresh. Later initialize calls read the current info and live_turn and do not recreate the refresh task or an execution container. The lightness here is "no model turn is started", not "no file I/O at all".

Shutdown first has the supervisor stop accepting new tasks, then cancels the refresh and closes executions and managed resources. This way cleanup happens while the resource owners still exist, and an exiting Worker does not keep accepting new process-start requests. A normal exit can persist an explainable terminal state; force-killing the process can only rely on later recovery to identify the uncertain state.

Code entry points: [Worker](../../../agent/runtime/server/worker.py), [the session service](../../../agent/runtime/server/session_service.py). Verification: [Worker lifecycle](../../../test/test_runtime_worker.py), [the startup draft](../../../test/test_startup_session.py).

[Back to the series map](../README.md)
