# `rind run`: a request-scoped Surface

English | [简体中文](one-shot.zh-CN.md)

one-shot compresses the interactive CLI's event stream into a single command: the final answer is written only to stdout, intermediate assistant text plus tool and task progress go to stderr, and within the request scope it waits for associated background tasks to complete or be delivered.

~~~mermaid
sequenceDiagram
    participant P as shell
    participant O as one-shot
    participant W as Worker
    P->>O: run --prompt --dir [--session]
    O->>W: request completion_scope=request
    W-->>O: assistant/task events
    O-->>P: progress -> stderr
    W->>W: wait for this request's on_exit / continuation
    W-->>O: response.answer
    O-->>P: answer -> stdout (once)
    O->>W: shutdown
~~~

The launch arguments require a prompt; an absolute workspace and session may also be given. The Worker runs with `--no-user-question`. If initialization advertises the rind/request-completion capability, the CLI sends completion_scope=request in the prompt request; without that capability it shows a compatibility warning and falls back to waiting for a single turn. The Worker performs the wait for associated tasks, so the CLI does not need to poll all processes repeatedly.

The request scope records the tasks created by this request_id and does not miscount tasks left over from older sessions; it ends only when there is no busy turn, no associated on_exit task, and no deliverable notification. Task failures are delivered first as a model-visible notification, so a single non-zero exit from the shell does not automatically make the one-shot a failure. A request interruption, a model failure, or a failed final shutdown makes the command return non-zero.

The run log is written under `logs` in the caller's current directory, even if `--dir` points to another workspace. A run shares the same local Runtime as interactive windows — its conversation stays visible to every window and the Agents page, and a second run reuses the already-started host — so after it finishes the shared host keeps running like any other; stop it from the Background page or with `rind agents stop`. With `--trace-llm` (host-wide tracing) the run keeps its own private worker instead, and the client is closed in the finally phase either way.

Source: [one-shot](../../../frontend-cli/lib/one-shot.js), [progress output](../../../frontend-cli/lib/one-shot-progress.js). Verification: [one-shot tests](../../../frontend-cli/test/one-shot.test.js). Related: [Task notifications](../05-autonomy/task-notifications.md).

[Back to the series map](../README.md)
