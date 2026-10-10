# `rind send`: find the running CLI, then deliver input

English | [简体中文](send.zh-CN.md)

`rind send` targets a running CLI Surface, not a bare Worker, and not "any session that exists can be sent to". It first connects to that Surface's local IPC listener; once it has the quick acknowledgement, the target terminal continues to display the results.

~~~mermaid
sequenceDiagram
    participant S as rind send
    participant I as target CLI IPC
    participant C as CLI dispatch
    participant W as Worker
    S->>I: {input} (2s connect/ack)
    I-->>S: {ok, session_id}
    I->>C: dispatchExternal(input)
    C->>W: command or session/prompt
    W-->>C: events and answers
    C-->>I: target terminal renders
~~~

Windows uses the `\\.\pipe\rind-<session>` named pipe; Unix uses `$RIND_HOME/ipc/<session>.sock`. At startup the listener probes for orphaned Unix sockets and removes them only after confirming that no active service is using them. Empty input, invalid JSON, and sessions that are shutting down are rejected.

An acknowledgement means the target process has received the input, not that the model has finished. The target CLI first hands input to the command controller; ordinary text then goes to the turn controller, which opens a turn when idle and enters the steering queue through sessionSteer when busy. Results and errors still appear in the target terminal. `rind send` itself does not replicate Worker events, nor does it take over session ownership.

## How one test observer connects

~~~sh
rind send --session <id> "The regression tests failed; check the latest error first."
~~~

The session ID can be found in a running CLI's startup information or in `/status`. When the CLI is idle, the input issues a single prompt; while it is sampling, ordinary text enters steering and is delivered before the next sampling. Input beginning with a slash also goes through the target CLI's command handling, so send is an input channel, not a network API that sends only chat bodies.

If a session exists only on disk and its CLI has exited, the local IPC endpoint is unavailable; to resume a saved session, use a normal CLI or `run --session`. The acknowledgement returns immediately, before dispatch, so a later queue-full, command error, or execution failure is still reported by the target Surface. A successful `send` exit therefore cannot be taken as proof that the task succeeded.

Source: [IPC listener/client](../../../frontend-cli/lib/ipc.js), [external dispatch](../../../frontend-cli/lib/cli-input-actions.js), [send command](../../../frontend-cli/lib/send.js). Verification: [IPC tests](../../../frontend-cli/test/ipc.test.js), [input errors](../../../frontend-cli/test/input-errors.test.js).

[Back to the series map](../README.md)
