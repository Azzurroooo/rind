# Inside Rind: Understanding the Worker kernel

English | [简体中文](README.zh-CN.md)

**[Open the full reading map: 9 groups, 52 articles](internals/README.md)**

This series explains how Rind's current code works from five angles — system structure, execution timeline, data projection, capability extension, and reliability. Each article includes a Mermaid diagram, a mechanism explanation, and source-code and test entry points.

| Topic | Start here |
| --- | --- |
| System overview and boundaries · 5 articles | [System map](internals/00-architecture/system-map.md) |
| Worker and the execution kernel · 9 articles | [Worker lifecycle](internals/01-runtime/worker-lifecycle.md) |
| Context and compaction · 7 articles | [Prompt assembly](internals/02-context/prompt-assembly.md) |
| Persistence · 5 articles | [Session structure](internals/03-persistence/session-store.md) |
| Tool system · 8 articles | [Tool registry](internals/04-tools/tool-registry.md) |
| Long-running tasks and collaboration · 5 articles | [Managed tasks](internals/05-autonomy/managed-tasks.md) |
| Models · 3 articles | [Provider adapters](internals/06-models/provider-adapters.md) |
| Surfaces · 6 articles | [Interactive CLI](internals/07-surfaces/interactive-cli.md) |
| Cross-cutting engineering · 4 articles | [Trust boundaries](internals/08-engineering/trust-boundaries.md) |

Want the design essentials first? Read [Resource ownership](internals/01-runtime/resource-ownership.md), [Compaction handoff](internals/02-context/compaction-handoff.md), [Dual views of tool results](internals/04-tools/tool-results.md), [Task notifications and continuation](internals/05-autonomy/task-notifications.md), [one-shot request scope](internals/07-surfaces/one-shot.md).

Need to run the project? Read [Running the CLI from source](internals/07-surfaces/interactive-cli.md#running-from-source), [Configuration and credentials](internals/06-models/authentication-and-settings.md), [Desktop](internals/07-surfaces/desktop.md), [Web/Mobile](internals/07-surfaces/web-and-mobile.md), [Messaging gateway](internals/07-surfaces/gateway.md).
