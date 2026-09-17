# CLI Rendering Architecture (pi-style TTY Infrastructure)

frontend-cli's terminal presentation uses a "single component tree + full-buffer diff rendering" model (borrowed from pi's tui design). This document describes its structure and key mechanisms.

## Layering

```text
lib/tui/
├── tui.js            # createTui engine: diff rendering, viewport bookkeeping, scheduling, cursor positioning
├── component.js      # Component / Container base classes
├── input-buffer.js   # escape-sequence reassembly, bracketed paste extraction
└── cursor.js         # cursor marker insertion (ANSI-aware)
lib/components/
├── text-block.js     # static text block (width-cached wrapping)
├── dynamic-block.js  # width-rebuilt dynamic block (user input, startup banner)
├── assistant-message.js  # streaming markdownish message component
├── composer-area.js  # prompt chrome + editor + menus (with cursor markers)
└── monitor-stack.js  # height-bounded composition of composer + task monitor
```

## Core contracts

- Session info exposes `team_main: { agent_id, project_name } | null` on initialize, create, and switch. The backend derives it from the workspace's Team manifests only for the configured main agent; it is not persisted. The CLI uses it for the startup badge/identity line and the persistent composer badge, and clears it when a switched session omits it. These badges use the active theme's `notice` color and remain readable as `[TEAM]` with `NO_COLOR`.
- Components implement only `render(width) -> string[]`; height is the number of returned lines, with no layout negotiation.
- After application state changes, call `tui.requestRender()`; the engine coalesces requests and throttles to 16ms.
- Per frame: render the whole tree into a line array → extract cursor markers → reset SGR at line ends → diff line by line against the previous frame → rewrite only the changed region (wrapped in DEC 2026 synchronized output, a single write).

## Redraw strategy

1. The first frame prints directly below existing terminal content without clearing — startup never wipes shell history.
2. Width/height change while content is drawn → clear screen and scrollback with `\x1b[2J\x1b[H\x1b[3J`, then **replay everything**. All history is re-wrapped at the new width — this is how history reflows after a resize.
3. Changed lines pass the viewport top (`firstChanged < previousViewportTop`) → full replay.
4. Otherwise incremental update: pure appends take a fast path; shrinkage clears surplus trailing lines.
5. Viewport bookkeeping (`previousViewportTop`, `hardwareCursorRow`, `maxLinesRendered`) keeps incremental updates landing correctly after content scrolls past the screen.

Scheduling contract: in `requestRender(force)`, force only means "skip the 16ms throttle and draw on the next tick"; it never resets diff bookkeeping, and whether to clear the screen is decided solely by doRender's geometry checks. `replayAll()` is the one exception: it invalidates every component cache and reuses the resize path (clear screen + scrollback, full replay) for appearance-level changes such as theme switches — which is why all blocks pick colors at render time (AssistantMessage stores the raw markdown, log() accepts thunks, ToolBlock re-renders each frame).

## Content model

- **transcript** (`Container`): the startup banner, user echo, assistant messages, tool lines, errors, and runtime stderr are all block components, appended in order.
- **AssistantMessage**: created on the turn's first delta and resident until the message ends; it holds the full raw text and a per-line render cache, and only unfinished lines participate in reflow while streaming.
- **composer**: rebuilt each frame from session state (prompt chrome, editor wrapping, menus); `CURSOR_MARKER` pins the hardware cursor at the input position, and the hardware cursor stays hidden when a frame has no focus marker. While a turn/compaction runs, the composer is the steering input and injects no marker — nothing blinks in the Working state (except the custom-answer editor in the question menu).
- **monitor**: the task monitor renders as the region after the composer, height-bounded by the remaining viewport so the composer stays visible.
- **tool blocks**: one persistent block per `tool_call_id` (`components/tool-block.js`). Requests appear with the custom titles from `tool-display.js` (`$ cmd`, `edit <path>`, `grep /p/ in src`, etc.), show a local seconds timer and a heartbeat line while running, and on completion turn **in place** into result rendering: bash tail output, edit diff counts with colored +/- lines, grep/glob match counts, delegate summaries, and so on. Collapse limits are per-tool; overflow shows `… (N more lines · ctrl+o to expand)`, and the global **ctrl+o** toggles expansion for all blocks. Renderers are pure functions and receive the authoritative width.

## Invariants

- Single authoritative width: the engine's `columns()` is the only source, handed down via `render(width)`; components must not read `process.stdout.columns`.
- All stdout writes must go through the engine; external text always becomes a transcript block — no side-channel writes.
- When a rendered line's visible width exceeds the terminal width, the engine truncates defensively (`RIND_DEBUG_REDRAW=1` exposes why full redraws happen).

## Tests

- `test/helpers/virtual-terminal.js`: a virtual terminal built on `@xterm/headless` (a devDependency; runtime stays zero-dependency) that can assert what the screen actually shows, scrollback, and hardware cursor position.
- `test/tui-engine.test.js` covers engine strategy; `test/tui-integration.test.js` exercises streaming, resize reflow, and monitor height limits with the real controller + engine; `test/tui-input-buffer.test.js` covers input reassembly.
