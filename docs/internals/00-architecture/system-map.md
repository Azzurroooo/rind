# Rind at a glance

English | [简体中文](system-map.zh-CN.md)

The core of Rind is not any particular interface, but one reusable execution path: the Surface hands input to the protocol, the Worker coordinates the session and its execution, the kernel calls models and tools, and results are written to disk and returned as events.

~~~mermaid
flowchart TB
    S["CLI / Desktop / Web / Mobile / Gateway"] --> P["Protocol connection"]
    P --> D["RuntimeDispatcher"]
    D --> W["RuntimeWorker"]
    W --> SS["SessionService<br/>reads persistent sessions"]
    W --> EC["ExecutionCoordinator<br/>manages active executions"]
    EC --> A["AgentContainer<br/>assembled on demand"]
    A --> R["AgentRuntime + TurnRunner"]
    R --> C["ContextManager"]
    R --> M["Model adapter"]
    R --> T["Tool handler"]
    C --> F[("JSONL session")]
    T --> F
    R --> E["RuntimeEvent"]
    E --> D --> P --> S
~~~

The Server and the execution kernel live in the **same Python Worker process**; no second layer of RPC sits between them. The CLI and Desktop connect over stdio JSONL, Web and Mobile go over WebSocket, and the Gateway attaches to the same protocol through its own WorkerClient. The Surface is responsible for input, presentation, and connection state; Python is responsible for sessions, context, models, tools, and tasks.

The diagram also has a reverse edge that is easy to leave out: session facts are written to disk, and the next execution reads them back. A Worker can keep running tasks and shared services, but it does not keep a standing Agent for every historical session. As you read the articles that follow, keep the three states distinct: **persistent facts, current execution, and Surface view**.

## Three forms of the same session

| Form | Where it lives | How long it lasts |
| --- | --- | --- |
| Persistent facts | Files such as messages, tool_calls, meta, tasks | Across turns and across Worker restarts |
| Current execution | Containers, model connections, queues, cancellation signals | While execution is active |
| Surface view | The Surface's transcript, input box, and task panel | Determined by the client lifecycle; can be rebuilt |

For example, refreshing the browser loses only the third layer: the Worker keeps executing, and once the client resubscribes, the view is rebuilt from history and snapshots. A Worker restart loses the second layer: the persistent session can still be opened, but the old process cannot automatically recover into a controllable process from a task_id alone. It is more accurate to judge problems along these three layers than to read "the session is still there" as "all state is still there".

Code entry points: [main.py](../../../main.py), [RuntimeWorker](../../../agent/runtime/server/worker.py), [assembly root](../../../agent/bootstrap/container.py). Verification: [architecture boundary tests](../../../test/test_agent_architecture.py).

[Back to the series map](../README.md)
