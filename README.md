<p align="center">
  <img src="assets/rind.svg" alt="Rind logo" width="104" />
</p>

<h1 align="center">Rind</h1>

<p align="center">
  A compact Python agent runtime for coding workflows, built around clarity, resumability, and small composable tools.
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12+-blue.svg" alt="Python 3.12+" />
  <img src="https://img.shields.io/badge/Architecture-layered-success.svg" alt="Layered architecture" />
  <img src="https://img.shields.io/badge/Interface-CLI-informational.svg" alt="CLI interface" />
</p>

## What is Rind?

Rind is a standard Python implementation of an autonomous coding agent. It is designed to be useful as a local CLI tool, but also readable enough to serve as a reference implementation for how an agent runtime can be assembled.

The project takes a restrained position: an agent should not become a large framework before it becomes a reliable instrument. Rind keeps the structure explicit, the tool contracts small, and the runtime state recoverable. From context compaction to tool execution, each part is implemented in the smallest form that preserves a good working experience.

## Design Principles

- **Subtract before adding**: Rind favors fewer concepts, smaller modules, and explicit boundaries. New abstractions are introduced only when they reduce real complexity.
- **Small tools, clear contracts**: Shell, file, web, plan, and skill tools are exposed through compact interfaces and predictable result shapes.
- **Context is runtime state**: Context estimation, compaction, and tool-result normalization are treated as first-class runtime responsibilities, not as prompt afterthoughts.
- **Local-first continuity**: Sessions, messages, tool calls, and compactions are persisted as append-only local records so work can resume after interruption.
- **Standard Python over framework gravity**: The codebase uses ordinary Python modules, dependency inversion, async orchestration, and focused services instead of a heavy plugin framework.
- **Good defaults, visible mechanics**: The CLI aims to feel direct and practical while still making model, session, cwd, status, and diagnostics visible when they matter.

## Capabilities

- Interactive coding-agent CLI with streaming output, slash commands, session resume, status rendering, and setup diagnostics.
- OpenAI-compatible async chat client with configurable model, base URL, and reasoning effort.
- Append-only JSONL session storage for messages, tool calls, compactions, and session metadata.
- Runtime context management with budget estimation, automatic compaction, context-length rescue, and normalized tool outputs.
- Lightweight session-local `update_plan` tool for tracking multi-step work across turns.
- Built-in tools for shell execution, file operations, web retrieval, planning, and skill discovery.
- Headless JSONL runtime server and experimental JS frontend CLI for separating terminal input/rendering from the Python agent loop.

## Quick Start

### Requirements

- Python 3.12+
- An API key for an OpenAI-compatible chat completion endpoint

### Install

```bash
git clone https://github.com/Azzurroooo/rind.git
cd rind

python -m venv .venv
```

On Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements-runtime.txt
```

On macOS or Linux:

```bash
source .venv/bin/activate
pip install -r requirements-runtime.txt
```

### Configure

Rind stores user-level data under `RIND_HOME` when set, otherwise under `~/.rind`. The default settings path is `<user-dir>/settings.json`; sessions, user skills, and user `RIND.md` live in the same user-level directory. You can also use environment variables such as `OPENAI_API_KEY`, `OPENAI_API_BASE`, and `DEFAULT_MODEL`.

Minimal `settings.json` example:

```json
{
  "model": "your-model-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "reasoningEffort": "high"
}
```

Run diagnostics before starting a session:

```bash
python main.py --doctor
```

### Run

```bash
python main.py
```

Resume the latest local session:

```bash
python main.py -c
```

Resume a specific session:

```bash
python main.py --session <session-id>
```

Experimental JS frontend CLI:

```bash
node frontend-cli/bin/rind.js
```

This starts a headless Python runtime over JSONL stdio and keeps terminal input/rendering in Node.js. The existing Python CLI remains available through `python main.py`.

## CLI Commands

| Command | Description |
| --- | --- |
| `python main.py` | Start a new interactive agent session. |
| `python main.py -c` | Resume the latest local session. |
| `python main.py --session <id>` | Resume a specific session by ID. |
| `python main.py --debug` | Disable streaming and show detailed runtime/tool diagnostics. |
| `python main.py --doctor` | Check local setup without requiring a valid API key. |

Inside the CLI, slash commands provide local controls for diagnostics, sessions, model selection, and status inspection. The input toolbar shows the active session, model, working directory, and key hints.

Project-level `RIND.md` and project skills are resolved from the current working directory where Rind is launched.

## Architecture

Rind follows a layered structure with dependency inversion between the runtime core and infrastructure adapters.

```text
agent/
├── application/
│   ├── runtime/       # Agent runtime, turn runner, stream parsing and pumping
│   ├── context/       # Context manager, estimation, compaction, token usage
│   ├── tools/         # Tool execution, processing, guards, result normalization
│   └── ports/         # Chat client, session store, tool registry abstractions
├── domain/            # Events, cancellation, planning and tool contracts
├── infrastructure/
│   ├── llm/           # OpenAI-compatible async chat client
│   ├── persistence/   # Append-only session records and repositories
│   ├── planning/      # Session-local plan storage and compact snapshots
│   └── tools/builtin/ # Shell, file, web, plan, and skill tools
└── interfaces/
    ├── cli/           # Interactive CLI, slash commands, status UI
    ├── runtime_server/# JSONL stdio adapter for headless runtime use
    └── api/           # FastAPI session streaming adapter
frontend-cli/          # Experimental Node.js terminal input/rendering process
```

Runtime and persistence boundaries are documented in [`docs/runtime-and-persistence.md`](docs/runtime-and-persistence.md).

## Development

Install development dependencies:

```bash
pip install -r requirements.txt
```

Run the test suite:

```bash
pytest test/ -q
```

The tests cover runtime events, context budgets, compaction, session persistence, resume behavior, tool result normalization, lightweight plans, skills, CLI rendering, and slash commands.

## Direction

Rind is an exploration of how far agent systems can go while remaining small enough to understand. Its future work is guided by three questions:

- How can an agent become more capable without accumulating unnecessary mechanism?
- What new interfaces and presentations can make agent work more inspectable, continuous, and calm?
- Which general design patterns can help Python agents become easier to build, test, package, and reason about?

The project is intentionally modest in shape, but ambitious in what it tries to clarify: a capable agent can be built from simple parts, visible state, and disciplined boundaries.

## License

This project is released under the [MIT License](LICENSE).
