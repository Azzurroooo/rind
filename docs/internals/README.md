# Inside Rind: architecture and Worker internals reading map

English | [简体中文](README.zh-CN.md)

This series contains **9 groups and 52 articles** of mechanism documentation. Each article starts from one question and one Mermaid diagram, explains the current implementation, the key sequences and the scope of guarantees, and attaches source-code and test entry points. The repository source code that this compilation is based on is authoritative; the test links exist to trace contracts and do not mean every test was run during this documentation pass. The "stateless" in quotes here means specifically **durable session state is on disk**: a Worker still holds in-flight tasks, cancellation signals, queues, and shared resources.

## The overall narrative

~~~mermaid
flowchart LR
    S["Surface<br/>CLI · Desktop · Web · Mobile · Gateway"] --> P["Protocol and transport"]
    P --> W["Worker Server<br/>Session access · Execution coordination"]
    W --> R["Execution kernel<br/>AgentRuntime · TurnRunner"]
    R --> C["Context<br/>Assembly · Budget · Compaction"]
    R --> M["Model adaptation<br/>Streaming output"]
    R --> T["Tool system<br/>Calls · Results · Background tasks"]
    C --> D["Durable facts<br/>Sessions · Tools · Task logs"]
    T --> D
    D --> W
    W --> E["Events · Replay · Snapshots"]
    E --> P
~~~

What ties the articles together is not "which classes exist", but five design tensions:

| Design tension | Rind's answer | Key articles |
| --- | --- | --- |
| Many entry points and a single execution semantic | Surfaces handle interaction; the Worker takes on execution over one unified protocol. | Surface/Worker, unified protocol |
| Long sessions and low resident load | Disk holds session facts; the execution container exists only when needed. | Resource ownership, session lifecycle |
| Full history and finite context | Keep the raw record; project, estimate, and compact the model view on demand. | Message projection, ContextManager, compaction handoff |
| Long-running tasks and single-turn conversation | Process facts go to disk first; notifications and automatic continuation are delivered across turns. | Background task logs, automatic continuation |
| Rich tools and a stable interface | ToolSpec, structured results, and dual projection isolate tool differences. | Tool registry, call chain, tool results |

The whole documentation set looks at one system from five angles; each article belongs to exactly one group, and the other angles cross-reference it through the reading paths, to avoid explaining the same thing twice:

| Angle | Question the reader wants answered | Corresponding sections |
| --- | --- | --- |
| Spatial structure | Where do components live, who depends on whom, who owns resources? | 00, 01, 07 |
| Temporal process | How do a request, a turn, and a background task each start and end? | 01, 05, 07 |
| Data shapes | What are the raw history, the model context, events, and snapshots respectively? | 02, 03 |
| Capability extension | How do you plug in models, tools, Skills, Teams, and a new Surface? | 02, 04, 05, 06, 07 |
| Reliability | What is still guaranteed after a disconnect, a cancellation, a restart, or exceeding a limit or failing? | 01, 03, 08 |

## 00 · System overview and boundaries (5 articles)

Build the map first, then get into the implementation. The focus is "one engine, many entry points" and explicit dependency boundaries.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [Rind at a glance](00-architecture/system-map.md) | Which layers does a request cross, and which state is left behind? | Global structure diagram |
| [Surfaces and the Worker](00-architecture/surface-worker.md) | Who is responsible for input, rendering, protocol, and execution? Why can the kernel be reused? | Process boundary diagram |
| [Layers and the composition root](00-architecture/layers-and-composition.md) | How do domain, application, runtime, and infrastructure connect through bootstrap without reverse dependencies? | Dependency diagram |
| [The unified protocol](00-architecture/protocol.md) | How do request, response, event, capability, and method form a stable contract? | Protocol structure diagram |
| [Different transports, same protocol](00-architecture/transports.md) | How do the connection and close semantics of stdio, WebSocket, and Electron preload differ? | Transport topology diagram |

## 01 · The Worker and execution kernel (9 articles)

From the resource lifecycle to single-turn execution, and on to events, cancellation, and recovery.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [The life of a Worker](01-runtime/worker-lifecycle.md) | What is created and released at startup, initialization, request, and shutdown respectively? | Lifecycle sequence diagram |
| [The key to low load](01-runtime/resource-ownership.md) | How do Worker shared resources, sessions persisted to disk, and on-demand creation and idle release of the execution container work together? | Resource ownership diagram |
| [One execution channel per session](01-runtime/execution-coordinator.md) | How do user turns, goal checkpoints, and task continuations compete for the same execution position? | Arbitration state diagram |
| [The inner loop of a turn](01-runtime/turn-loop.md) | How does input pass through context, model sampling, and tool calls until termination? | Sequence diagram |
| [The streaming model boundary](01-runtime/model-stream.md) | How are incremental text and tool arguments parsed, rate-limited, batched, and kept in order? | Bounded-queue data-flow diagram |
| [Steering and Follow-up](01-runtime/input-queues.md) | When do interjections before sampling, follow-ups after completion, retraction, and promotion each take effect? | Dual-queue sequence diagram |
| [The event system](01-runtime/event-system.md) | What are the responsibilities of domain events, the protocol envelope, durable/incremental, and session/turn IDs? | Event-flow diagram |
| [Replay and resubscribe](01-runtime/replay-and-resubscribe.md) | How do the history cursor, the current-turn snapshot, and the background-task snapshot reassemble full state after a disconnect? | Reconnect sequence diagram |
| [Cancellation, failure, and resumption](01-runtime/cancellation-and-recovery.md) | How does cancellation propagate across model/tool/process? How is an unclosed tool call recovered without executing it again? | Failure branch diagram |

## 02 · Context, memory, and compaction (7 articles)

This group answers "what does the model actually see", separating context assembly from the on-disk history.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [Where instructions come from](02-context/prompt-assembly.md) | How do the base system prompt, RIND.md, Goal/Team instructions, the Skill catalog, and transient messages enter the request? | Prompt source layering diagram |
| [ContextManager](02-context/context-manager.md) | How do persistent messages, runtime injections, Skills, and pending input compose the final model messages? | Assembly pipeline diagram |
| [Context budget](02-context/context-budget.md) | How do local estimation, server-usage anchors, window headroom, and context inspect avoid blind stuffing? | Budget allocation diagram |
| [When to compact](02-context/compaction-triggers.md) | Why do manual, automatic, and context-overflow recovery share a pipeline, yet different callers decide whether sampling continues? | Trigger state diagram |
| [The compaction handoff](02-context/compaction-handoff.md) | How do the history summary, the most recent messages kept verbatim, tool pairing, failure fallback, and boundary checks guarantee resumability? | Before/after compaction comparison diagram |
| [Progressive disclosure of Skills](02-context/skills.md) | How do metadata discovery, scope overrides, explicit activation, and snapshot persistence avoid loading the full text every turn? | Discovery and activation sequence diagram |
| [Images entering the context](02-context/image-input.md) | How are user-uploaded and tool images snapshotted, stored, capability-checked, and adapted to the model request? | Image data-flow diagram |

## 03 · Persistence and the source of truth (5 articles)

They explain "what is stored on disk" and "how the runtime interprets those records" separately, never equating the chat record with the model context.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [Session on-disk structure](03-persistence/session-store.md) | What is recorded in meta, messages, tool_calls, compactions, indexes, and attachments? | Storage layout diagram |
| [From raw history to the model view](03-persistence/message-projection.md) | How are internal messages, compaction boundaries, tool results, and reasoning content projected without rewriting the raw record? | Projection pipeline diagram |
| [Session creation, restoration, forking, and deletion](03-persistence/session-lifecycle.md) | Why is the startup draft persisted to disk lazily? What does a fork copy, and which running tasks are not copied with it? | Lifecycle state diagram |
| [Background task logs](03-persistence/task-journal.md) | How do appended facts, the Worker lease, deduplication, and the post-restart lost state support recovery? | Log and recovery sequence diagram |
| [The usage ledger](03-persistence/usage-ledger.md) | What are the respective sources of sampling usage, compaction usage, session statistics, and summary reports? | Data lineage diagram |

## 04 · The tool system (8 articles)

Start with the unified call chain, then explain why different tools need different resource and result contracts.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [ToolSpec and the registry](04-tools/tool-registry.md) | How do schema, argument normalization, availability, and the executor compose an extensible tool boundary? | Tool assembly diagram |
| [A single tool call](04-tools/tool-call-lifecycle.md) | How is model output parsed, validated, executed, normalized, persisted to disk, and emitted as events, and how is it deduplicated during recovery? | Full sequence diagram |
| [Two views of the same result](04-tools/tool-results.md) | Why are structured results, model-visible content, terminal display, full on-disk output, truncation, and pagination kept separate? | Dual-projection data-flow diagram |
| [File reading and writing](04-tools/file-tools.md) | How do paged reads, glob/grep, single-point edit, per-path write queues, and write-then-replace staging work together? | Read/write path diagram |
| [Controlled processes and background execution](04-tools/shell-tools.md) | How are bash, task_control, process trees, output cursors, cancellation, and timeouts managed by the Worker? | Process state diagram |
| [Web search and fetch](04-tools/web-tools.md) | How do search, fetching, session reuse, and bounded content preserve the tool contract? | Request data-flow diagram |
| [User questions inside tools](04-tools/user-questions.md) | What is the relationship between suspended execution, protocol replies, and the non-interactive one-shot? | Question-and-answer sequence diagram |
| [A plan is not a conversation](04-tools/plan.md) | How do update_plan's session file, snapshots, and the compaction handoff keep the plan visible? | Plan state diagram |

## 05 · Long-running tasks, goals, and collaboration (5 articles)

These mechanisms span a single model turn; they are the backbone of "an Agent that can keep working".

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [The background-task state machine](05-autonomy/managed-tasks.md) | How are command return, a continued process, manual reads, waiting for release, and the final state separated? | Task state diagram |
| [Automatic continuation](05-autonomy/task-notifications.md) | Tool results are submitted first, the notification is delivered when the task completes, and acknowledgment comes after the model consumes it — how is loss or duplication avoided? | Submit-notify-consume sequence diagram |
| [Durable Goals](05-autonomy/goals.md) | How do active/paused/blocked/complete, checkpoints, completion evidence, and continuation gates work? | Goal state diagram |
| [Team](05-autonomy/teams.md) | How does a Team exist as a registry relationship, and how is work divided between the Worker and the control plane? | Control-plane structure diagram |

## 06 · Models and providers (3 articles)

Explain how model differences stop at the adapter layer instead of seeping into the execution kernel.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [The unified model interface](06-models/provider-adapters.md) | How are the messages, tools, streaming events, and cancellation of OpenAI Chat/Responses, Anthropic, and Gemini normalized? | Adapter-layer structure diagram |
| [Capabilities and the catalog](06-models/model-catalog.md) | How do built-in definitions, remote refresh, cache validity, the context window, and image_input determine available capabilities? | Capability resolution diagram |
| [Configuration and credentials](06-models/authentication-and-settings.md) | What are the responsibility boundaries of Provider login, where settings come from, model selection, and secret storage? | Configuration flow diagram |

## 07 · How Surfaces reuse the kernel (6 articles)

Input, state, and connections are explained around the Surface/Worker boundary; source-run, configuration, and build entry points are preserved as well.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [The interactive CLI](07-surfaces/interactive-cli.md) | How does the Node Surface maintain input, deliver requests, consume events, and render stably? | CLI-Worker sequence diagram |
| [rind run](07-surfaces/one-shot.md) | How does completion_scope=request wait for this task and its continuations; why are stdout, stderr, and logs split apart? | Request scope diagram |
| [rind send](07-surfaces/send.md) | How does another terminal find the target session, and how is input delivered when it is busy or idle? | Cross-process sequence diagram |
| [Desktop](07-surfaces/desktop.md) | How are the Electron main, preload, renderer, and the shared live Worker isolated? | Process topology diagram |
| [Web and Mobile](07-surfaces/web-and-mobile.md) | How do WebSocket, reconnection, remote access, and the Capacitor container reuse the Web Surface? | Connection topology diagram |
| [The messaging gateway](07-surfaces/gateway.md) | How do channel adapters, session routing, deduplication, event cursors, and Worker connections combine? | Gateway data-flow diagram |

## 08 · Cross-cutting constraints and engineering verification (4 articles)

Explain the design's invariants, boundaries, and evidence, instead of showing only the happy path.

| Article | Question to read about | Main diagram |
| --- | --- | --- |
| [Trust boundaries](08-engineering/trust-boundaries.md) | At which boundaries are file paths, Team private spaces, credentials, external web pages, and process output constrained? | Trust boundary diagram |
| [A bounded system](08-engineering/limits-and-backpressure.md) | At which layer are stream queues, event queues, context, tool output, and background processes rate-limited respectively? | Limits location diagram |
| [Seeing the kernel](08-engineering/observability.md) | How do context inspect, events, usage, trace, and debug locate the problem in a single turn? | Observability data-flow diagram |
| [How the design is verified](08-engineering/verification.md) | What do protocol golden fixtures, unit and fake-provider process tests, virtual terminals, and manual acceptance each prove? | Test layering diagram |

## Recommended reading paths

| Reader | Order |
| --- | --- |
| New to Rind | [System map](00-architecture/system-map.md) → [Surface/Worker](00-architecture/surface-worker.md) → [Worker resource ownership](01-runtime/resource-ownership.md) → [The single-turn inner loop](01-runtime/turn-loop.md) → [Context assembly](02-context/context-manager.md) → [Session storage](03-persistence/session-store.md) → [The event system](01-runtime/event-system.md) |
| Modifying the Worker kernel | [Layering and composition](00-architecture/layers-and-composition.md) → [Execution coordination](01-runtime/execution-coordinator.md) → [The turn inner loop](01-runtime/turn-loop.md) → [A tool call](04-tools/tool-call-lifecycle.md) → [Cancellation and recovery](01-runtime/cancellation-and-recovery.md) → [Replay](01-runtime/replay-and-resubscribe.md) |
| Understanding the "clever ideas" | [Low-load resource ownership](01-runtime/resource-ownership.md) → [The compaction handoff](02-context/compaction-handoff.md) → [Dual-view tool results](04-tools/tool-results.md) → [Task submit/notify/consume](05-autonomy/task-notifications.md) → [The one-shot request scope](07-surfaces/one-shot.md) |
| Plugging in a new entry point or model | [The unified protocol](00-architecture/protocol.md) → [Transports](00-architecture/transports.md) → [Events and replay](01-runtime/replay-and-resubscribe.md) → [Provider adapters or the matching Surface](06-models/provider-adapters.md) |

## One scenario that ties everything together

The user asks to "run the tests, analyze the failures, and fix them": the Surface issues a prompt → the execution coordinator assembles the session container → ContextManager builds the model view → the model proposes bash → the Worker supervisor manages the process → the initial tool result is submitted → once the long command hands control back, the turn container can be released → the task's terminal state is written to the log → the notification gate initiates the continuation → the new container reads the session and continues processing. When the history grows too long, compaction replaces only the model view; when the client disconnects, replay is responsible for rebuilding the display.

The three sequences most worth noting on this chain are: **facts go to disk before notifications are delivered; the resource owner is settled before deciding when to release; the raw history is kept before a finite view is constructed.** Each article explains the conditions and exceptions under which these sequences hold.

Adjacent topics are deliberately divided: the protocol covers the public contract, transports cover connections; Shell covers process control, background tasks cover cross-turn semantics; task logs cover stored facts, automatic continuation covers when to consume; events cover real-time notification, replay covers state reconstruction; compaction triggers cover the decision, the compaction handoff covers fidelity and recovery.

[Back to documentation](../README.md) · [Back to the project](../../README.md)
