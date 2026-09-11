<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="118" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  <strong>A local coding agent built light — automate it, delegate to it, extend it, reach it from anywhere.</strong>
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

## What makes Rind different

Four decisions shape what Rind can do for you:

### Hand it a job and walk away

```bash
rind run --prompt "Summarize the changes in src/" --dir /workspace/project
```

One-shot mode is the same agent, headless: the final answer on `stdout`, progress on `stderr`, a full markdown run log under `logs/`, and `--session <id>` to continue an earlier task. Questions are disabled so automation cannot hang. Long commands run in the background while the session keeps working — **Ctrl+B** opens a live monitor for background tasks and delegates.

> Hooks, cron jobs, and pipelines get an agent with a clean contract.

### A Team of specialists that keep their state

Traditional subagents are disposable: prompt in, summary out, memory gone. A Rind Team is filesystem-native and durable — each delegated agent is a first-class session with **its own workspace directory, its own tool set and workspace policy, and its own persistent history** (`.aiteam/agents/<name>/`). Create an expert once (`/team init`, `/team blueprint`, `/team add`); every later task starts from what it already knows and has already written, and results publish back as real files.

> Specialists that accumulate expertise instead of restarting from zero on every task.

### A stateless kernel that stays light

The worker keeps no heavy resident state: agent containers exist only while a turn runs and are released the moment it ends. Everything durable — messages, tool calls, compactions, usage — lives in append-only JSONL on disk. Disk is the truth; memory is only coordination, so a crash loses nothing and a long-lived process stays as light as a fresh one.

> Small footprint, instant recovery, nothing hidden in RAM.

### One engine, four doors

**CLI** for keyboard-first terminal work · **Desktop** for a visual multi-project overview · **Web** over a single WebSocket (a browser that sleeps mid-task reconnects and catches up) · **IM gateway** for Telegram and Discord. Same sessions, same protocol, same engine — the door changes, the work doesn't.

> Your sessions follow you across surfaces instead of being locked into one.

**Plus `rind send`**: deliver a prompt into a running session from any terminal or script — `rind send --session <id> "…"` starts a turn on an idle session and steers a busy one; the session id is the address.

### And the standard kit, done properly

Mid-turn steering and queued follow-ups · session fork at any past message · live context telemetry (`/context` — every number measured, estimates marked `~`) · append-only JSONL sessions (crash-safe, replayable, isolated by `RIND_HOME`) · live-turn crash recovery · project docs (`RIND.md`) auto-injected into context · skills · plans · four TTY themes with streaming markdown, tables, and CJK-aware rendering · `/doctor` that tells you what's wrong.

## Quick start

**Install** — pick one:

```bash
# Prebuilt installer (Windows/macOS/Linux) from GitHub Releases
# or:
npm install -g @rind-ai/cli
# or from source:
git clone https://github.com/Azzurroooo/rind.git && cd rind
python -m venv .venv && . .venv/bin/activate   # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
```

**Configure** — a complete `.rind/settings.json` in the workspace, falling back to `~/.rind/settings.json`:

```json
{
  "model": "your-model-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "reasoningEffort": "high"
}
```

Any OpenAI-compatible endpoint works. Then:

```bash
rind                          # interactive CLI
rind --session <id>           # open a specific session
```

## Four surfaces, one engine

| Surface | Use it when | How |
| --- | --- | --- |
| **CLI** | Keyboard-first pairing, terminal workflows | `rind` |
| **Desktop** | Visual multi-project overview | `npm --prefix desktop run dev` (from source) |
| **Web** | Browser access, remote machines, shared box | `docker compose up -d --build` → `http://localhost:8080` |
| **IM gateway** | Telegram / Discord as the front end | `python main.py gateway --config .rind/gateway.yaml` |

The web surface runs the long-lived WebSocket worker; a browser that disconnects mid-task reconnects and catches up via incremental replay — close the laptop, reopen, continue. One endpoint, one token, no second REST API. For remote access prefer a private network (Tailscale/WireGuard) or a TLS tunnel (`cloudflared tunnel --url http://localhost:8080`); never expose the raw worker port without TLS. Configure via `.env`:

```dotenv
RIND_WORKSPACE=/absolute/path/to/workspace
RIND_HOME=/absolute/path/to/rind-data
RIND_WEB_PORT=8080
RIND_WEB_BIND=127.0.0.1
RIND_SERVER_TOKEN=change-me
```

The gateway only makes outbound connections, interpolates `${VAR}` from the environment (unknown keys are startup errors, never silent defaults), and pairs unknown senders with a one-time code (`python main.py gateway approve <CODE>`). In Docker it is opt-in: `docker compose --profile gateway up -d`.

## The engine underneath

```text
CLI / Desktop / Web / IM / your app
          |
          |  JSONL requests + session/update events
          v
      Rind Worker
          |
          +-- turns, steering, cancellation
          +-- model adapter (OpenAI-compatible)
          +-- tools and workspace
          +-- context management and compaction
          +-- append-only session records (JSONL)
```

Three decisions make this shape work:

- **One worker, any client.** Sessions identify work, turns scope execution, and every event carries its session and turn identity plus a durability level. A new surface speaks the same protocol instead of reimplementing the turn loop.
- **Disk is the truth.** Sessions live in plain append-only JSONL under `~/.rind` (or `RIND_HOME`). Process crashes lose nothing; live turns are snapshotted and resumed; history replays exactly.
- **A small kernel.** Model client, session store, tool registry, context manager, turn scheduling, cancellation — a short list of replaceable ports, no framework graph between your code and the agent loop.

**For builders**, the extension points map directly to source:

| You want to add or replace | Start at |
| --- | --- |
| Model provider | `ChatClient` and its client factory |
| Model-facing capability | `ToolSpec` and `ToolRegistry` |
| Storage backend | `SessionStore` |
| Context policy | Context and compaction services |
| Human command | Worker command registry or a surface command |
| New UI | JSONL protocol and `session/update` |

## CLI cheat sheet

| Keys | Meaning |
| --- | --- |
| **Enter** | send — or steer while a turn runs |
| **Tab** | queue a follow-up · **Alt+↑/↓** recall queued/steered text · **Alt+→** promote a follow-up |
| **Ctrl+B** | background-task monitor · **Ctrl+O** expand tool output · **?** shortcut sheet |
| **Ctrl+C** | interrupt turn / quit |

| Commands | Meaning |
| --- | --- |
| `/context` | context breakdown + usage board (real tokens) |
| `/fork` `/sessions` `/compact` | branch, switch, or free context |
| `/model` `/effort` `/theme` | pick model, reasoning effort, color theme |
| `/goal` `/skill` `/team` `/doctor` `/help` | autonomous goal, skills, team, diagnostics, commands |

| Entry points | Meaning |
| --- | --- |
| `rind` / `rind --session <id>` | interactive |
| `rind run --prompt "…" [--session <id>]` | headless, pipeable |
| `rind send --session <id> "…"` | inject into a running session |

## Documentation & development

[Architecture](docs/architecture.md) · [CLI rendering](docs/cli-rendering.md) · [CLI turn flow](docs/cli-turn-flow.md) · [Main pipeline](docs/main_pipeline.md)

```bash
pip install -r requirements.txt && pytest test/ -q   # runtime
cd frontend-cli && npm install && npm test           # CLI
```

## License

[MIT](LICENSE)
