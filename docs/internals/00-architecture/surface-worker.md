# Surface and Worker: interaction and execution separated

English | [简体中文](surface-worker.zh-CN.md)

The same task can be started from a terminal, the desktop, a browser, or a phone, because each of these entry points only translates user actions into protocol requests, and translates events back into a readable interface.

~~~mermaid
flowchart TB
    subgraph Surface["Surface: interaction process"]
        I["Edit input / menu"] --> C["Runtime Client"]
        C --> V["Event-driven interface state"]
    end
    C -->|"request_id + method"| B["Protocol boundary"]
    B -->|"response / session/update"| C
    subgraph Worker["Worker: Python process"]
        B --> S["Runtime Server"]
        S --> R["Execution kernel"]
        R --> F[("Session files")]
    end
~~~

The CLI's [runtime-client.js](../../../frontend-cli/lib/runtime-client.js) starts or connects to the Worker; input buffering, the cursor, and TTY rendering all stay in Node. On the desktop, Electron main owns the Worker subprocess, and the renderer can only call through the methods exposed by preload. Web connects over WebSocket; Mobile reuses the Web Surface, with Capacitor providing pairing and native capabilities, so there is no Python kernel on the phone.

**The benefit of the boundary is clear responsibilities.** Switching to a different interface does not require copying the model loop; changing tool semantics does not require scattering business decisions across multiple Surfaces. A protocol response marks the end of a request, while independent events represent changes during execution; an interface must not treat the two as two separate answers.

## Where interaction state and business state divide

| Stays in the Surface | Stays in the Worker |
| --- | --- |
| Input buffer, cursor, expand/collapse state | Accepted input queue, message commit, turn end state |
| Menu selection, task cards, notification presentation | Tool execution, background task facts, Goal scheduling |
| Connecting, reconnecting, error messages | Session storage, model calls, compaction boundary |

This does not require the frontend to be "stateless". The frontend must hold enough state to keep input and rendering stable, but execution facts are governed by the Worker and the persistent record. For example, a draft the user is editing should not disappear because of one background update; conversely, a client showing a task as completed cannot replace the Worker's task end state.

Code entry points: [CLI client](../../../frontend-cli/lib/runtime-client.js), [Desktop Worker management](../../../desktop/src/main/runtime.ts), [Web client](../../../frontend-web/src/runtimeClient.js). Verification: [CLI protocol tests](../../../frontend-cli/test/runtime-client.test.js), [Web protocol tests](../../../frontend-web/src/runtimeClient.test.js).

[Back to the series map](../README.md)
