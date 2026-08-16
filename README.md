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
  <img src="https://img.shields.io/badge/Surfaces-CLI%20%2B%20Desktop-informational.svg" alt="CLI and Desktop surfaces" />
</p>

## What is Rind?

Rind is a lightweight coding agent with two product surfaces: a Node.js frontend CLI and an Electron desktop app. Both use the same Python Runtime Package, which is also readable enough to serve as a reference implementation for a compact agent runtime.

The project takes a restrained position: an agent should not become a large framework before it becomes a reliable instrument. Rind keeps the structure explicit, the tool contracts small, and the runtime state recoverable. From context compaction to tool execution, each part is implemented in the smallest form that preserves a good working experience.

## Design Principles

- **Subtract before adding**: Rind favors fewer concepts, smaller modules, and explicit boundaries. New abstractions are introduced only when they reduce real complexity.
- **Small tools, clear contracts**: Shell, file, web, plan, and skill tools are exposed through compact interfaces and predictable result shapes.
- **Context is runtime state**: Context estimation, compaction, and tool-result normalization are treated as first-class runtime responsibilities, not as prompt afterthoughts.
- **Local-first continuity**: Sessions, messages, tool calls, and compactions are persisted as append-only local records so work can resume after interruption.
- **Standard Python over framework gravity**: The codebase uses ordinary Python modules, dependency inversion, async orchestration, and focused services instead of a heavy plugin framework.
- **Good defaults, visible mechanics**: Both surfaces keep model, session, workspace, status, and diagnostics visible when they matter.

## Capabilities

- Frontend CLI and Desktop experiences with streaming output, slash commands, session resume, status rendering, and setup diagnostics.
- OpenAI-compatible async chat client with configurable model, base URL, and reasoning effort.
- Append-only JSONL session storage for messages, tool calls, compactions, and session metadata.
- Runtime context management with budget estimation, automatic compaction, context-length rescue, and normalized tool outputs.
- Lightweight session-local `update_plan` tool for tracking multi-step work across turns.
- Built-in tools for shell execution, file operations, web retrieval, planning, and skill discovery.
- One headless JSONL Runtime Server shared by both surfaces; Python has no interactive CLI.

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

Rind reads API configuration only from `~/.rind/settings.json`. Desktop and CLI share this exact file. `RIND_HOME` may still control runtime data such as sessions, but never API configuration.

Minimal `settings.json` example:

```json
{
  "model": "your-model-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "reasoningEffort": "high"
}
```

### Run

Frontend CLI:

```bash
node frontend-cli/bin/rind.js
```

Desktop app:

```bash
npm --prefix desktop run dev
```

The Python entrypoint is the headless Runtime Package used by both surfaces:

```bash
python main.py app-server --stdio --cwd .
```

The Runtime Package exposes one JSONL protocol to both surfaces. Session switching, model selection, goals, background tasks, slash commands, and turn control are handled through that protocol; Python does not provide a separate interactive UI.

Project-level `RIND.md` and project skills are resolved from the current working directory where Rind is launched.

## Architecture

Rind follows a layered structure with dependency inversion between the runtime core and infrastructure adapters.

```text
agent/
├── runtime/
│   ├── core/          # Agent runtime, turn runner, stream parsing and pumping
│   └── server/        # JSONL server façade, protocol, and runtime commands
├── application/
│   ├── context/       # Context manager, estimation, compaction, token usage
│   ├── tools/         # Tool execution, processing, guards, result normalization
│   └── ports/         # Chat client, session store, tool registry abstractions
├── domain/            # Events, cancellation, planning and tool contracts
├── infrastructure/
│   ├── llm/           # OpenAI-compatible async chat client
│   ├── persistence/   # Append-only session records and repositories
│   ├── planning/      # Session-local plan storage and compact snapshots
│   └── tools/builtin/ # ToolSpec implementations and build_builtin_tool_specs catalog
frontend-cli/          # Node.js terminal Surface
desktop/               # Electron desktop Surface
```

Runtime and persistence boundaries are documented in [`docs/architecture.md`](docs/architecture.md).

## Development

Install development dependencies:

```bash
pip install -r requirements.txt
```

Run the test suite:

```bash
pytest test/ -q
```

The tests cover runtime events, context budgets, compaction, session persistence, resume behavior, tool result normalization, plans, skills, protocol handling, and Surface rendering.

## Direction

Rind is an exploration of how far agent systems can go while remaining small enough to understand. Its future work is guided by three questions:

- How can an agent become more capable without accumulating unnecessary mechanism?
- What new interfaces and presentations can make agent work more inspectable, continuous, and calm?
- Which general design patterns can help Python agents become easier to build, test, package, and reason about?

The project is intentionally modest in shape, but ambitious in what it tries to clarify: a capable agent can be built from simple parts, visible state, and disciplined boundaries.

## License

This project is released under the [MIT License](LICENSE).
