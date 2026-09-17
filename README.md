<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="100" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  <strong>Build a team of agents. Give their work a home.</strong>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Azzurroooo/rind/releases"><img src="https://img.shields.io/github/v/release/Azzurroooo/rind?label=release" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/@rind-ai/cli"><img src="https://img.shields.io/npm/v/@rind-ai/cli" alt="npm package" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

Rind is an **open-source AI coding agent** with persistent specialist workspaces, scriptable sessions, and a shared runtime for terminal, desktop, browser, and messaging clients. It runs on your machine and connects to your chosen model provider.

- **[Build a reusable team](#persistent-multi-agent-teams).** Give specialists a lasting role, a working directory, and files they can build on across tasks.
- **[Put sessions into your workflow](#programmable-sessions).** Run an agent from a script or send new instructions into a live terminal session.
- **[Build on the engine](#one-runtime-multiple-clients).** Connect a new interface to the same tools, context management, and session protocol.

## Get started

With **Node.js 18+**:

```bash
npm install -g @rind-ai/cli
cd your-project
rind
```

Inside Rind, run `/login` to connect a provider, then `/model` to choose a model. Built-in adapters cover OpenAI, Anthropic, Google, DeepSeek, and more; custom OpenAI-compatible endpoints are configurable too.

Prefer an installer? Get the **Windows, macOS, or Linux CLI** from [Releases](https://github.com/Azzurroooo/rind/releases). See the [setup guide](docs/getting-started.md) for custom endpoints, source installation, and other clients.

**Explore before spending tokens.** The interactive tour demonstrates real CLI layouts with simulated tasks: pause, rewind, and jump straight to a feature. It makes no model calls and needs no API key.

```bash
rind tour team.create
```

The tour is available on `main`, after v0.8.0; use the [source setup](docs/getting-started.md#from-source) to try it today. Run `rind tour` for the catalog, or `/tour` inside a session.

## Persistent multi-agent teams

**Give recurring work to a specialist with a place to keep it.** A test specialist can maintain fixtures and testing notes; a researcher can preserve findings and source material. Their workspaces remain available for the next assignment.

A Team lives in ordinary directories. The main agent coordinates specialists, and `shared/` holds the files they exchange:

```text
my-project/
├── .aiteam/project.yaml         # Team identity and main-agent selection
├── agents/
│   ├── main-agent/              # Coordinator workspace
│   └── test-specialist/
│       ├── .aiteam/agent.yaml   # Specialist identity
│       ├── .aiteam/prompts/     # Role instructions
│       ├── memory/             # Notes worth keeping
│       ├── work/               # Working files
│       └── outputs/            # Local deliverables
└── shared/                     # Inputs and published handoffs
```

Each execution creates a separate, persisted session. **Continuity comes from the specialist's role and files**: new tasks can inspect previous work, while old conversations remain separate records. The main agent gets a concise result and paths to published artifacts it can verify.

Independent assignments can run concurrently. A specialist works within its own workspace and the shared area through the file tools, keeping private working material separate from published handoffs.

### Try your first team

In a Rind session at your project root:

```text
/team create
/exit
```

Creation leaves the current session in place. Start a new one in the coordinator's workspace:

```bash
cd agents/main-agent
rind
```

Then, inside Rind:

```text
/team add A test specialist that writes regression tests and maintains testing notes
/team list
```

Put the material to work on in the project's `shared/` directory, then ask the main agent:

> Delegate to the test specialist: inspect shared/parser/, write Unicode regression tests, and publish the tests and a short handoff under shared/.

Use the agent ID shown by `/team list` when naming a specialist. **Ctrl+B** opens the delegate monitor. For future projects, `/team blueprint` creates specialists from templates you install under `~/.rind/blueprints/`.

## Programmable sessions

**Let a script start the work—or contribute to work already in progress.** Rind exposes both paths:

```bash
# Produce an answer that another program can consume.
rind run --prompt "Review the current diff for breaking API changes" > review.md

# Send an update from another terminal to an open Rind CLI session.
rind send --session <id> "The integration tests failed; investigate before continuing."
```

`run` writes the final answer to **stdout**, progress to **stderr**, and a Markdown run summary to `logs/` in the launching directory. User questions are disabled; failures return a nonzero exit code. Add `--session <id>` to continue a saved session or `--dir <absolute-path>` to choose the workspace.

`send` addresses a running CLI session on the same machine: it starts a turn when idle and steers the current turn when busy. Find the session ID in the startup banner or `/status`. Delivery is acknowledged immediately; the answer appears in the target session. This lets a test watcher or local script contribute findings without taking over your terminal.

## One runtime, multiple clients

**Choose where you work; reuse the agent underneath.** The clients share the session protocol and runtime implementation:

| Client | What it gives you | Start here |
| --- | --- | --- |
| **CLI** | Direct terminal work and script integration | `rind` |
| **Desktop** | A visual workspace for multiple projects | [Run from source](docs/getting-started.md#desktop) |
| **Web** | Browser access to a long-lived worker | [Docker or local setup](docs/getting-started.md#web) |
| **Messaging gateway** | Work through Telegram, Discord, Slack, Feishu, and other adapters | [Gateway setup](docs/getting-started.md#messaging-gateway) |

With the Web client, closing the browser leaves the worker running; reconnecting restores the session view. Local clients can reopen saved sessions when configured to use the same session store.

The runtime creates an agent execution container when work starts and releases it when idle. Messages and tool-call history are stored as JSONL on disk, so reopening a session does not require keeping its model client and conversation in memory between turns.

### See what goes into the model

`/context` breaks down the last assembled context into instructions, conversation, tool definitions, and tool results. It shows local token estimates alongside provider-reported usage where available; the usage page aggregates activity across sessions. When context grows, you can see which inputs are responsible before deciding what to compact or change.

## Build on Rind

Rind separates clients, execution, and infrastructure. A custom interface consumes requests and `session/update` events; a new capability plugs into the tool registry.

| Extend | Entry point |
| --- | --- |
| Client or integration | [Runtime protocol](agent/runtime/server/protocol.py) |
| Model-facing tool | [ToolSpec](agent/infrastructure/tools/spec.py) and [tool registry](agent/infrastructure/tools/registry.py) |
| Provider or storage adapter | [Application ports](agent/application/ports) |
| Context assembly and compaction | [Context services](agent/application/context) |

For the design behind these boundaries, see [Architecture](docs/architecture.md), [CLI rendering](docs/cli-rendering.md), and [Tour internals](docs/cli-tour.md). For commands and shortcuts, use `/help` and `?` inside Rind.

[Issues](https://github.com/Azzurroooo/rind/issues) and pull requests are welcome. The [development guide](docs/getting-started.md#development) covers setup and tests.

## License

[MIT](LICENSE)
