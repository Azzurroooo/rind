# One protocol, different connection lifetimes

English | [简体中文](transports.zh-CN.md)

The transport layer only delivers protocol messages; it does not reimplement Agent behavior. The most important difference is **who owns the Worker's lifetime**.

~~~mermaid
flowchart TB
    CLI["CLI Node process"] -->|"stdio / JSONL"| WS["StdioRuntimeServer"]
    DESK["Electron main"] -->|"stdio / JSONL"| WS
    WEB["Web / Mobile"] -->|"WebSocket"| WW["WebRuntimeServer"]
    GATE["Gateway WorkerClient"] -->|"stdio or WebSocket"| X["Protocol connection"]
    WS --> D["RuntimeDispatcher"]
    WW --> D
    X --> D
    D --> W["RuntimeWorker"]
~~~

A stdio connection is bound to the Worker it starts: local connections from the CLI and Gateway close stdin and wait for stdout to drain and the process to exit; a normal shutdown waits for the Worker to stop the tasks it owns itself. A WebSocket connection, on the other hand, can disconnect and reconnect, and closing the browser does not automatically kill a long-lived Worker. Desktop isolates the subprocess through Electron main, and preload limits the methods the renderer can call.

The WebSocket entry point also validates connection credentials; it is not as simple as "swapping stdio for a network port". Subscription, replay, and snapshots at the protocol layer let the view be restored once a long-lived connection drops, while execution semantics stay inside the Worker.

## After a connection drops, who is still alive

| Entry point | Transport and owner | What to conclude after a disconnect |
| --- | --- | --- |
| Local CLI / one-shot | The Surface starts the stdio subprocess | The Surface initiates a normal shutdown and waits for exit |
| Desktop local interface | renderer → preload → main → stdio | main owns the Worker, not a single UI component |
| Standalone Web | WebSocket → Python WebRuntimeServer | Closing a single socket is not a service exit |
| Desktop remote access | WebSocket → Electron Gateway → local Worker | Revoking a remote entry point can preserve local execution |
| Messaging Gateway | Its own WorkerClient chooses stdio or WebSocket | A process you start yourself and a service you merely connect to carry different cleanup responsibilities |

The WebRuntimeServer in the diagram is the standalone Python Web mode; the Desktop remote Gateway is a different bridging route. They share protocol semantics, but that does not make authentication, process ownership, and exit flows the same implementation.

Code entry points: [stdio](../../../agent/runtime/server/stdio.py), [WebSocket](../../../agent/runtime/server/websocket.py), [Desktop bridge](../../../desktop/src/preload/types.ts). Verification: [Web Runtime tests](../../../test/test_web_runtime.py), [stdio shutdown tests](../../../test/test_gateway_stdio_shutdown.py).

[Back to the series map](../README.md)
