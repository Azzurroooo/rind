# Interactive CLI: the terminal as a Surface

English | [简体中文](interactive-cli.zh-CN.md)

The CLI handles only input, display, and connection lifecycle. Sessions, turns, tools, and persistence remain the Worker's responsibility. As events arrive, the CLI updates a single component tree, which the TUI then draws.

~~~mermaid
sequenceDiagram
    participant T as Terminal
    participant C as Node CLI/TUI
    participant W as Worker stdio
    T->>C: Keyboard, paste, commands
    C->>W: request(method, params)
    W-->>C: response + event stream
    C->>C: reducer / transcript / viewport
    C-->>T: frame diff (synchronized output)
~~~

Interactive commands go through the command controller, ordinary text goes to the turn controller, and steering and follow-up are handled by separate queue actions. External `send` injects into the same dispatch path through the CLI's own IPC listener, so remote input still obeys the same command and queue semantics.

The TUI's render(width) produces logical lines, and the root component owns the diff; the default minimum draw interval is 33ms. When a write returns false the TUI waits for drain, so a fast model stream cannot flood stdout. Drawing uses DEC 2026 synchronized update, cursor markers, and the viewport, and the input buffer and cursor are preserved across refreshes.

Without a TTY, cursor control and menus are not started: `rind run` writes the final answer to stdout, and progress and diagnostics to stderr. Pipelines therefore consume a clean answer, while the interactive display can still show tool and task status.

## Tour: a real renderer, simulated execution

`rind tour` and the in-session `/tour` demonstrate the CLI layout, but neither starts a Worker nor calls a model. Pages store step data, the player manages playback, the stage manages simulated state, render produces the picture, and only run-tour holds the TUI. Fictional events travel through the existing transcript/output controllers, so examples and real sessions can reuse the same tool blocks, streaming Markdown, and menu layout.

The Agents Management tutorial uses serializable fictional snapshots and reuses the real management page's row projections, task forms, and delivery-report renderers without connecting to the management service. `agents.tasks` shows a managed parent task ending its turn, waiting for a child task's delivery, and then starting a new run in the same session. `agents.sessions` is distinguished from ordinary direct chat: dispatch creates a task only for the receiving member, never an extra parent task, and it does not promise automatic continuation after delivery.

The Agents chapter teaches entirely through interactive operation and shows no management subcommands: press Left in the empty input box to enter, `n` opens the new-team form, `a` opens the member-type menu, then fill in the folder, the role/responsibility, or the worktree's repository, branch, directory, and base; when an owner already exists, a copy/share choice is shown. Members' session lists and chat entry points are also displayed by the interface; the simulated forms never access disk and never call management actions.

Run `/tour agents.create`, `/tour agents.tasks`, or `/tour agents.sessions` to view the management tutorial; `/tour login.account` demonstrates OpenAI account authorization, `/tour login.endpoint` a named endpoint, and `/tour config.folder` folder defaults. The forms, credentials, tasks, and test results in the tour are all simulated: no authorization page is opened, no configuration is written, and no file is created.

The management page itself needs a minimum width of 40 columns, and the tour frame costs another 4; use a terminal at least 44 columns wide to view its full screen. On narrower terminals the tutorial text is still readable, and the management page's size hint is shown.

Entering the tour from within a session pauses the main TUI; on leaving it, replayAll restores the original session display. The playback clock can be injected, so tests do not have to wait for the animations in real time. The tour verifies the interface tutorial and rendering, not a model's ability to complete a piece of work.

## Running from source

Python 3.12+ and Node.js 18+ are required. First create a virtual environment in the repository root:

~~~sh
python -m venv .venv
~~~

Activate it with `.\.venv\Scripts\Activate.ps1` on Windows PowerShell or `source .venv/bin/activate` on macOS/Linux, then install and run:

~~~sh
python -m pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
~~~

To launch from another workspace, use the absolute path to the CLI script; in the examples, `rind` can be replaced with `node /absolute/path/to/rind/frontend-cli/bin/rind.js`. For login and endpoint settings, see [Configuration and credentials](../06-models/authentication-and-settings.md). If you only want to see how it works, run `node frontend-cli/bin/rind.js tour agents.create`, which requires an interactive terminal.

Source: [CLI implementation](../../../frontend-cli/lib/frontend-cli-implementation.js), [input actions](../../../frontend-cli/lib/cli-input-actions.js), [TUI](../../../frontend-cli/lib/tui/tui.js), [runtime client](../../../frontend-cli/lib/runtime-client.js), [Tour](../../../frontend-cli/lib/tour/run-tour.js). Verification: [TUI engine](../../../frontend-cli/test/tui-engine.test.js), [virtual terminal integration](../../../frontend-cli/test/tui-integration.test.js), [input buffer](../../../frontend-cli/test/tui-input-buffer.test.js), [Tour](../../../frontend-cli/test/tour-tui.test.js).

[Back to the series map](../README.md)
