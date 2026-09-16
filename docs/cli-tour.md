# CLI Tour (`rind tour` / `/tour`)

An interactive feature walkthrough: a simulated terminal plays a scripted
animation — starting rind, typing commands, tool blocks, streamed replies —
while caption notes explain what happens. Everything is drawn by the CLI's own
renderers, so the tour looks exactly like a real session and follows the active
theme, width, CJK rules and `NO_COLOR`.

Pure frontend. The tour never spawns the runtime and never touches `agent/`.

## Entries

- `rind tour [page]` — standalone subcommand next to `run`/`send`. Requires a
  TTY; without a page id it opens the catalog. Unknown ids list the catalog on
  stderr. `rind help` is normalized to `rind --help`.
- `/tour [page]` — slash command inside a session (registered in
  `LOCAL_SLASH_COMMANDS`, so it shows up in `/help`, `?` and the slash menu).
  The main TUI stops, the tour plays below the transcript, and on exit
  `replayAll()` restores the session. The process `SIGINT` handler is removed
  for the duration because raw mode is released between the two TUIs.
- First launch shows a one-line hint under the banner until `tourSeen` is set
  in `~/.rind/cli-state.json` (set by both entries after a completed tour).

## Layering

```text
lib/tour/
├── run-tour.js        # TUI lifecycle, TourScreen component, key wiring
├── player.js          # playback state machine, injected clock, catalog
├── stage.js           # pure stage state machine (begin/settle/tick/rebuildTo)
├── render.js          # stage + player state -> lines (frame, caption, status)
└── pages/
    ├── index.js       # TOUR_TOPICS catalog, findTourPage
    ├── steps.js       # step constructors — the only vocabulary pages may use
    ├── demo.js        # shared fake project fixtures
    └── <topic>.js     # content pages (start, team, sessions, model, …)
```

Dependencies point one way: `run-tour → player → {stage, render, pages}`.
Clock (`schedule`/`cancel`) and streams are injected, so tests are fully
deterministic. Only `run-tour.js` writes to a terminal, via its own
`createTui` instance.

## Step vocabulary

Every step is plain data. Kinds: `shell`, `shell-out`, `startup`, `type`,
`submit`, `result`, `tool`, `assistant`, `menu`, `turn-done`, `exit`, `note`.

- `submit(mode)` — `send` (default) echoes the composer text and starts the
  turn; `queue` / `steer` park it in the composer's pending list, matching how
  tab/enter behave mid-turn.
- `menu(spec)` opens an interactive-menu beat rendered with the real menu
  renderers (`slashMenuText`, `modelMenuText`, `themeMenuText`,
  `sessionMenuText`, `choiceMenuText`, `backgroundMonitorText`,
  `delegateMonitorText`, `contextBoardText`/`usageBoardText`,
  `authChoiceFrame`, `authSecretFrame`); `selected` animates toward `target`,
  one step per tick. Menus close when a `result`/`submit`/`turn-done`/
  `exit`/`startup` step settles.
- A `note` field on any step replaces the caption from that step on; a bare
  `note` step additionally waits for a keypress.

Timing at 1× lives in `TIMING` (player.js): e.g. `shell` 24ms/char,
`type` 35ms/char, `assistant` 25ms/line, tool shows running for 700ms before
settling. `speed ∈ {0.5, 1, 2, 4}` scales the delays.

## Keys

| Key | Page view | Catalog |
| --- | --- | --- |
| space | pause / resume / continue a note / next page at the end | — |
| ← / → | back one step and pause for review / skip to the next | — |
| enter | settle the current step instantly | play selection |
| ↑ / ↓ | speed | move selection (wraps) |
| r | replay the page | — |
| q / esc / ctrl+c | back to catalog | quit |

## Rendering contract

- The stage stores raw data only (raw markdown, raw tool outcomes, raw menu
  specs); `render.js` styles at render time through `rendering.js`,
  `AssistantMessage`, `markdown-lines.js` and `theme.js` — the same functions
  the live session uses.
- The page body sits inside a `┌─ Tour · <title> ─…┐` panel so the simulation
  reads as a simulation; body rows wrap (never clip) to the panel width, and
  the catalog windows its rows like the app's own menus so it fits short
  terminals.
- The hardware cursor is pinned during typing (shell or composer) and hidden
  while the turn is "running" — mirroring `ComposerArea`.
- `rebuildTo(steps, i)` (instant rewind) and the animated path must produce
  identical snapshots; `tour-stage.test.js` asserts this for every step index.

## Tests

`node --test` covers: stage transitions and rebuild determinism
(`tour-stage.test.js`), rendered lines against fixture stages
(`tour-render.test.js`), playback timing/keys with a fake clock
(`tour-player.test.js`), catalog lint — unique ids, valid kinds, required
fields, at least one note per page, clean closing step
(`tour-content.test.js`), and full ANSI playback on an `@xterm/headless`
virtual terminal (`tour-tui.test.js`), and the in-session stop/run/replay recovery of the main transcript (`tour-insession.test.js`).
