# Rind Current Code Architecture

Rind has two product surfaces sharing one Runtime Package: `frontend-cli` provides the terminal experience and `desktop` provides the Electron UI. The Python entry point no longer hosts interactive UI; it only starts the Runtime Server.

## Layering

```mermaid
flowchart TB
    Surface["frontend-cli / desktop"] --> Server["agent/runtime/server\nprotocol, JSONL, commands"]
    Server --> Core["agent/runtime/core\nAgentRuntime, TurnRunner, stream"]
    Core --> Application["agent/application\ncontext, tools, ports"]
    Core --> Domain["agent/domain\nevents, errors, cancellation, goal"]
    Application --> Domain
    Bootstrap["agent/bootstrap/container.py"] --> Core
    Bootstrap --> Infrastructure["agent/infrastructure\nLLM, persistence, tools, config"]
    Infrastructure -. implements .-> Application
```

- `domain` holds only domain models and standard-library logic.
- `application` orchestrates context, tools, skills, and ports; it depends on no concrete provider or surface.
- `runtime/core` is the execution core: it owns turn lifecycles, input queues, and the event stream.
- `runtime/server` is the unified Server facade: protocol dispatch, capability declaration, session/model/goal/background control, and the reusable command catalog.
- `infrastructure` implements the LLM, the JSONL session store, tool registration, config, and workspace integration.
- `bootstrap` is the only production composition root; the Server obtains its dependencies through `build_agent_container()`.

`runtime/core` imports neither `runtime/server`, `bootstrap`, nor concrete infrastructure. Server and core call each other directly in the same process — no internal RPC and no duplicated runtime dependency objects.

## Runtime Package

```text
agent/runtime/
├── __init__.py
├── core/
│   ├── runtime.py          # AgentRuntime facade, turn lock, input queues, session control
│   ├── turn_runner.py      # context -> model -> tool main loop
│   ├── stream_parser.py    # provider stream parsing
│   └── stream_pump.py      # stream -> RuntimeEvent
└── server/
    ├── app_server.py       # workspace/config/container startup
    ├── protocol.py         # v2 methods, capabilities, envelope, errors
    ├── stdio.py            # JSONL transport and request dispatcher
    ├── resume_preview.py   # session resume summary
    └── commands/            # command catalog and runtime-safe handlers
```

## Surface protocol

The protocol is defined in `agent/runtime/server/protocol.py`, mirrored for the frontend in `frontend-cli/lib/runtime-protocol.js`, and the Desktop allowlist of methods derives from `desktop/src/preload/types.ts`. Common methods use standard semantics:

`initialize`, `shutdown`, `session/new`, `session/list`, `session/switch`, `session/replay`, `session/prompt`, `session/cancel`, `model/list`, `model/set`.

Product extensions use the `rind/` namespace and are gated by capability declaration: `rind/session/steer`, `rind/session/follow_up`, `rind/session/unsteer`, `rind/session/dequeue_follow_up`, `rind/session/compact`, `rind/command/execute`, `rind/user-question/respond`, `rind/goal/*`, `rind/background/*`. The two kinds of queued input each deliver FIFO; without an `input_id` the retrieval methods each fetch the newest item (LIFO), and with an `input_id` they can remove any specific not-yet-delivered item from the corresponding kind.

Events are uniformly envelopes with `method: "session/update"` carrying `sequence`, `durability`, session/turn ids, and `event.type`. Incremental events can be consumed live; durable events serve recovery and state synchronization. The public fixture lives at `test/fixtures/runtime_protocol.golden.jsonl`.

## Main data flow

```mermaid
sequenceDiagram
    participant Surface
    participant Server
    participant Runtime
    participant Runner
    participant Store

    Surface->>Server: session/prompt
    Server->>Runtime: run_turn(query)
    Runtime->>Runner: build context and stream model
    Runner->>Store: persist messages/tool calls
    Runner-->>Server: RuntimeEvent stream
    Server-->>Surface: session/update
    Server-->>Surface: response(session_id, turn_id)
```

Control requests duplicate no business logic: the Server calls the Runtime's `set_model`, `switch_session`, `compact_context`, goal APIs, and input queues; command handlers use the same runtime/session instances through `SlashCommandContext`.

The default startup session reserves a stable ID in memory. Status, replay, login, and model selection do not create its session directory; the first user task or explicit goal writes it under the same ID. A draft cannot be resumed by another worker before that write. Explicit `session/new` requests still persist immediately, preserving gateway routing across worker restarts. The repository retains only the startup draft store, and execution receives that store through the composition root.

## Entry points

```text
frontend-cli/bin/rind.js
  -> frontend-cli/lib/runtime-client.js
     -> python main.py app-server --stdio
        -> agent/runtime/server/app_server.py
           -> agent/bootstrap/container.py

desktop/src/main/index.ts
  -> desktop/src/main/runtime.ts
     -> python main.py app-server --stdio
```

The `desktop` main process isolates the worker, IPC, and project state; the renderer reaches the runtime only through the preload API. `frontend-cli` owns TTY/non-TTY input, menus, and text/Markdown rendering. Both consume the same methods, events, and capabilities. The CLI's TTY rendering uses a single component tree plus full-buffer diff architecture — see [`docs/cli-rendering.md`](cli-rendering.md).

## Test boundaries

- Python tests cover `runtime/core`, `runtime/server`, application/infrastructure, and the protocol fixtures.
- `frontend-cli/test` covers the protocol, controllers, input state, and rendering.
- `desktop/scripts` covers the fake runtime lifecycle, project/session adapters, and an app-server smoke test; Node 22+ is required to run the TypeScript source tests directly.
- The interactive Python CLI, its prompt renderer, and their tests have been deleted; the Python CLI is no longer a product entry point.
