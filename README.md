<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="118" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  <strong>A local coding agent you can use, automate, and rebuild.</strong>
</p>

<p align="center">
  Work with it in the terminal. Hand it a job. Split the work. Build your own surface.
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Azzurroooo/rind/releases"><img src="https://img.shields.io/github/v/release/Azzurroooo/rind?label=release&color=DF7A3A" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Python-3.12%2B-3776AB" alt="Python 3.12+" />
  <img src="https://img.shields.io/badge/Node-18%2B-3C873A" alt="Node 18+" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16A085" alt="MIT license" /></a>
</p>

<p align="center">
  <img src="assets/rind-architecture.svg" alt="Rind connects interactive work, automation, delegation, and custom clients to one local engine" width="960" />
</p>

## The point

Rind is a local-first coding agent for work that needs to keep moving. It can pair with you in a terminal or Desktop, answer one task from a script, or split focused work across a filesystem-native Team.

Rind is not a chat wrapper with tools glued on. Workspace access and agent execution stay in your process; model traffic goes only to the endpoint you configure. The core has a clear boundary, so every surface uses the same tools, turns, events, and protocol. Use the product as-is, or take the core apart and make it yours.

> Keep the center small. Let the work get bigger.

## Four ways to use it

| **Pair** | **Run** |
| --- | --- |
| Keyboard-first CLI or visual Desktop for coding, debugging, and exploration. | One-shot commands for CI, hooks, editor actions, and scheduled jobs. |
| **Delegate** | **Build** |
| A Team of focused agents sharing a project and a controlled workspace. | A small JSONL boundary for your editor, service, experiment, or new UI. |

### Pair with it

```bash
rind
```

Read and edit files, run shell commands, search the web, keep a plan, inspect skills, and watch the work stream as it happens. CLI and Desktop are different experiences on the same engine, so changing the surface does not change the agent.

```text
> You
  Trace the failing request, run tests, and fix what breaks.

* read   src/api/client.py
* bash   pytest -q
* edit   src/api/client.py

< Assistant
  Fixed the retry path. 12 tests passed.
```

### Run it headlessly

```bash
rind run --prompt "Summarize the changes in src/" --dir /workspace/project
```

One-shot mode is the same agent with the interactive layer removed:

- final assistant output goes to `stdout`;
- progress and diagnostics stay on `stderr`;
- `ask_user_question` is disabled by default, so automation cannot hang;
- `--session <id>` continues a task when a job needs context from an earlier run.

### Delegate the work

Team is filesystem-native and opt-in. Give the project a few focused agent profiles, then let the main agent delegate work without creating a second application or a second execution engine.

```text
.aiteam/
├── project.yaml
├── agents/
│   ├── reviewer/agent.yaml
│   └── weather/agent.yaml
└── shared/
```

```text
/team init       discover existing agent directories
/team list       inspect available agents
/team blueprint  browse user blueprints
/team add        create an agent from a blueprint
```

Each delegated job has an explicit session, workspace policy, tool set, and event stream. The same local engine handles creation, execution, cancellation, and result delivery.

## Why this shape works

### One core, any surface

The user-facing layer owns input and presentation. The local engine owns agent work and durable facts. A new client speaks the same JSONL protocol instead of reimplementing the turn loop.

```text
CLI / Desktop / your app
          |
          |  JSONL requests + session/update events
          v
      Rind Worker
          |
          +-- turns and cancellation
          +-- model adapter
          +-- tools and workspace
          +-- context and compaction
          +-- local session records
```

In the source, that local engine is a long-lived Python Worker. The name matters less than the boundary: sessions identify work, turns scope execution, and every event carries its session and turn identity.

### Small by default

Rind keeps the kernel to a short list of replaceable ports: model client, session store, tool registry, context manager, turn scheduler, and cancellation. Worker-level adapters are reused; turn state is temporary and released when work ends.

There is no required web stack, service mesh, or framework-sized dependency graph between your code and the agent loop.

### Composable tools

Shell, files, web retrieval, plans, skills, background work, and Team delegation are focused `ToolSpec` contracts. Add a capability by implementing a handler and registering its schema; the loop does not need to know its internals.

## For builders

Rind is intentionally easy to reshape:

| You want to add or replace | Start at |
| --- | --- |
| Model provider | `ChatClient` and its client factory |
| Model-facing capability | `ToolSpec` and `ToolRegistry` |
| Storage backend | `SessionStore` |
| Context policy | Context and compaction services |
| Human command | Worker command registry or a Surface command |
| New UI | JSONL protocol and `session/update` |
| Background workflow | Worker sessions and turn scheduling |

The public protocol stays compact:

```text
initialize
session/new       session/list       session/replay
session/prompt    session/cancel     session/switch
model/list        model/set          model/effort
rind/command/execute
session/update
```

`session/update` carries live and durable events with `session_id`, `turn_id`, sequence, and durability. You can render the stream, store it, or project it into another product without importing Python internals.

## Web Surface

### One-command deployment

With Docker Desktop or Docker Engine + Compose v2 installed, run from the repository root:

```bash
export RIND_SERVER_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(24))')"
docker compose up -d --build
```

Then open `http://localhost:8080` and sign in with `RIND_SERVER_TOKEN`. This starts the production web surface and the long-lived WebSocket worker together. The worker's WebSocket endpoint authenticates with a one-time ticket (browser) or a persistent token (scripts) — non-loopback binds refuse to start without a token. The current directory is mounted as the workspace and `./.rind` stores settings and sessions. Stop it with `docker compose down`.

Use a `.env` file when the defaults need changing:

```dotenv
RIND_WORKSPACE=/absolute/path/to/workspace
RIND_HOME=/absolute/path/to/rind-data
RIND_WEB_PORT=8080
RIND_WEB_BIND=127.0.0.1
RIND_SERVER_TOKEN=change-me
RIND_PYPI_INDEX_URL=https://pypi.org/simple
RIND_DEBIAN_MIRROR=deb.debian.org
```

Use `RIND_WEB_BIND=0.0.0.0` only when the host is protected by authentication and TLS — see [Remote access](#remote-access).

Start a long-lived worker over WebSocket and connect the browser surface independently:

```bash
python main.py app-server --web --host 127.0.0.1 --port 8765 --cwd <workspace>
cd frontend-web
npm install
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173`. Closing the browser only closes its WebSocket connection; the worker process and session execution continue running. On reconnect the web surface catches up missed durable events via incremental replay, so a laptop that sleeps mid-task rejoins with full history.

Omit `--session-dir` to use the same default `~/.rind/sessions` and session index as the CLI. When using a custom `--session-dir` or `RIND_HOME`, use the same value for both surfaces.

### Remote access

Rind keeps its attack surface small: one WebSocket endpoint, one token, no second REST API. To reach a worker on another machine:

- **Preferred: a private network.** Run Tailscale (or WireGuard) on the worker host and your devices, then point the browser at the tailnet address — no ports exposed to the public internet.
- **Tunnel:** `cloudflared tunnel --url http://localhost:8080` fronts the web surface with TLS; keep `RIND_SERVER_TOKEN` set.
- Never forward the raw worker port (8765) without TLS; the token travels in the handshake query.

### Message gateway (Telegram, Discord, and more)

The optional gateway process connects IM channels to the same worker — one connection subscribes to every channel session, so conversations continue where they left off.

A guided wizard does the whole setup — it prints step-by-step instructions for each channel's credentials, verifies them against the platform API before writing anything, installs channel SDKs on request, and resolves the worker connection on its own (probes for a running worker, falls back to self-hosting one — you never configure that by hand):

```bash
python main.py gateway init    # ~2 minutes, then start right from the wizard
python main.py gateway         # start; prints a one-screen ready panel
```

Unknown senders get a one-time pairing code in the chat; approve it on the machine running the gateway (`python main.py gateway approve <CODE>`, or run `approve` with no code to list pending requests). Every command has a safety net: `gateway status` shows sessions/pairing/channels/worker at a glance, and `gateway doctor` checks config → worker → channel SDKs → state files, with `--probe` to live-verify credentials. See [docs/gateway.md](docs/gateway.md) for the full walkthrough.

For scripted deploys, the wizard has a zero-interaction mode (`gateway init --yes --channel telegram` driven by `RIND_GW_<CHANNEL>_<FIELD>` variables) and hand-written `gateway.yaml` works too — `${VAR}` interpolates environment variables; unknown keys and undefined variables are startup errors, never silent defaults. Channel SDKs are optional per-channel dependencies (`requirements-gateway.txt`) and only import when a channel is enabled. In Docker, the gateway ships as an opt-in service: `docker compose --profile gateway up -d` with the config at `./.rind/gateway.yaml`. It only makes outbound connections — no inbound ports.

## Install

### Prebuilt CLI installers

Download the current CLI installer from [GitHub Releases](https://github.com/Azzurroooo/rind/releases):

- Windows x64: `.exe`
- macOS Intel: `.pkg`
- macOS Apple Silicon: `.pkg`
- Linux x64: `.deb`

Each installer includes the Node CLI and the matching native local engine. Desktop is distributed separately.

### npm

```bash
npm install -g @rind-ai/cli
rind --help
```

The CLI package selects the matching platform engine through optional dependencies.

### From source

```bash
git clone https://github.com/Azzurroooo/rind.git
cd rind
python -m venv .venv
```

On Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
```

On macOS or Linux:

```bash
source .venv/bin/activate
pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
```

Desktop (from source):

```bash
npm --prefix desktop install
npm --prefix desktop run dev
```

## Configure

Rind reads API settings from a complete `.rind/settings.json` in the active workspace. Without one, it falls back to `~/.rind/settings.json`.

```json
{
  "model": "your-model-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "reasoningEffort": "high"
}
```

Project settings are useful for isolated workspaces and Team agents. Keep API keys out of version control.

## Documentation

- [Architecture](docs/architecture.md)
- [CLI rendering](docs/cli-rendering.md)
- [CLI turn flow](docs/cli-turn-flow.md)
- [Main pipeline](docs/main_pipeline.md)

## Development

```bash
pip install -r requirements.txt
pytest test/ -q
```

CLI tests:

```bash
cd frontend-cli
npm install
npm test
```

## License

Rind is released under the [MIT License](LICENSE).
