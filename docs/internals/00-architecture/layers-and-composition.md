# Layers and composition: dependencies point one way

English | [简体中文](layers-and-composition.zh-CN.md)

The execution kernel describes "how to complete a turn"; the concrete model SDK, JSONL files, and tool implementations are injected by the composition root. The kernel does not need to know whether it is serving the CLI or the Web.

~~~mermaid
flowchart TB
    S["runtime/server<br/>protocol and coordination"] --> B["bootstrap/container.py<br/>the only production composition root"]
    B --> C["runtime/core<br/>turns and streaming"]
    B --> I["infrastructure<br/>models / storage / tools"]
    C --> A["application<br/>context / tool orchestration / ports"]
    A --> D["domain<br/>events / errors / cancellation"]
    C --> D
    I -. "implements ports" .-> A
~~~

[AgentContainer](../../../agent/bootstrap/container.py) explicitly receives the session store, the model client, ShellTools, WebSessions, and shared resources, then assembles ContextManager, ToolCallProcessor, TurnRunner, and AgentRuntime. runtime/core does not import runtime/server, bootstrap, or concrete infrastructure in reverse, and a Surface does not hold Python business objects either.

This makes the lifecycles legible: Worker-level resources are created by RuntimeWorker, a single active execution is assembled in ExecutionCoordinator, application depends on abstract ports, and infrastructure implements them outside the boundary. When adding a Provider or a tool, you usually change the adapter and the assembly rather than rewriting the turn loop.

## When reading the code, first find who owns the assembly

The fact that a tool needs a session ID, a cancellation signal, and output storage does not mean it should go looking for a global Worker on its own. ToolSpec declares the invocation contract, the container injects dependencies, the executor fills in private runtime parameters, and the concrete handler performs the action. The source of a dependency can be traced along the constructor, and tests can replace the model and file boundaries with local implementations.

The Server also carries execution mutual exclusion, cross-turn continuation, and connection subscription, so it cannot be abbreviated to "only forwarding requests". Core manages the sampling and tool loop inside one turn; application provides reusable services. The dependency graph shows module direction, not process isolation: in production these Python modules run in the same process.

Code entry points: [composition root](../../../agent/bootstrap/container.py), [application ports](../../../agent/application/ports/), [domain events](../../../agent/domain/events.py). Verification: [dependency direction tests](../../../test/test_agent_architecture.py), [container tests](../../../test/test_agent_container.py).

[Back to the series map](../README.md)
