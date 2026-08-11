# CLAUDE.md

Guidance for Claude Code when working in this repository. Mirrors `AGENTS.md` and adds project orientation.

## Project Overview

Rind is a compact Python 3.12+ coding-agent runtime with three frontends sharing one runtime core:

- **Python CLI** — `python main.py` (interactive), `--doctor`, `-c` / `--session <id>` to resume.
- **frontend-cli/** — experimental Node.js terminal frontend driving the headless runtime over JSONL stdio.
- **desktop/** — Electron client; spawns `python main.py app-server --stdio --cwd <workspace>` and talks JSONL.

Configuration comes only from `~/.rind/settings.json` (shared by CLI and desktop). Sessions persist as append-only JSONL under the Rind home, indexed with `workspace_root` scoping.

## Commands

```bash
pip install -r requirements.txt        # dev dependencies (requirements-runtime.txt for runtime only)
pytest test/ -q                        # Python test suite
python main.py --doctor                # setup diagnostics

cd desktop
npm test                               # node --test scripts/*.test.mjs (spawns a real app-server)
npm run typecheck                      # tsc --noEmit
npm run dev                            # electron-vite dev

cd frontend-cli
node --test test/                      # JS frontend tests
```

## Architecture

```
agent/
├── application/    # runtime (turn runner, stream parsing), context (estimation, compaction),
│                   # tools (execution, guards, normalization), ports (chat client, stores)
├── domain/         # events, cancellation, planning, tool contracts
├── infrastructure/ # OpenAI-compatible client, JSONL persistence, planning, skills, config
└── interfaces/     # cli/ (interactive CLI + slash commands), runtime_server/ (JSONL stdio), api/ (FastAPI)
```

Runtime and persistence boundaries: see `docs/runtime-and-persistence.md`.

## Coding Style and Naming

- Use Python 3.12+ style, 4-space indentation, and UTF-8 source files.
- Use `snake_case` for functions and variables, `PascalCase` for classes, and `UPPER_SNAKE_CASE` for constants.
- Keep tool outputs structured through `tool_ok` and `tool_error` patterns.
- Prefer small, focused functions and make side effects explicit, especially in `agent/infrastructure/tools` and persistence adapters.
- Prioritize high cohesion, low coupling, clear structure, and readability.
- For complete functionality, prefer concise, straightforward implementations. Avoid verbose, over-engineered, or needlessly complex code.
- Do not add redundant logic or fields.
- Do not add unused variables, interfaces, branches, or entities for speculative future needs.
- Use accurate, unambiguous names that avoid conflicts and make code self-explanatory without comments.
- Introduce new entities only when they are necessary for current functionality.
- Target Python files of 400 lines or fewer. Treat 800 lines as a review threshold, not a hard limit.
- Split files only when it improves cohesion, readability, or testability; never solely to reduce line count.

## CLI Design

- Keep rendering predictable: no flicker, stale text, input overlap, or layout failures from resize, long output, or error states.
- Do not interrupt interaction: background logs, tool output, status refreshes, and errors must not steal the cursor or corrupt the current input buffer.
- Make information easy to scan. Clearly present the current task, running state, error source, and available actions with concise labels and consistent alignment.
- Support terminal realities: TTY and non-TTY modes, Windows and Unix shells, narrow and wide terminals, UTF-8, CJK width, ANSI sequences, line endings, and redirected output.
- Bound long output. Use truncation, folding, paging, or debug-only expansion for long text, logs, tool results, and stack traces.
- Make errors recoverable. Normal mode should show actionable causes; debug mode may include details. Rendering failures must not terminate the main workflow.
- Control performance: throttle high-frequency refreshes, avoid unnecessary full redraws, and stream or chunk large output.
- Separate business state, interaction state, and rendering so core layouts can be tested as deterministic output.
- Use color, icons, spacing, and alignment quietly and consistently to improve usability.
- Test core layouts and interaction state transitions. Fall back to plain-text logs when dynamic UI is unavailable.
