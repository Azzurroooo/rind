# CLI Tour (`rind tour` / `/tour`)

An interactive feature walkthrough: a simulated terminal plays a scripted
animation — starting rind, typing commands, tool blocks, streamed replies —
while caption notes explain what to do in a real session. Screens reuse the
CLI's current renderers with fictional data. Before any simulated content
appears, a populated `TOUR` introduction card explains the lesson and shows
`READY · Enter / Space to start`. Once playback starts, a closed `Demo` frame contains
only the simulated terminal. A separate `TOUR GUIDE` region below its bottom
border owns the playback status, explanation, controls and progress track.
Theme, width, CJK and `NO_COLOR` follow the CLI.

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
  in `~/.rind/cli-state.json`. Both entries set it after reaching a page's final
  takeaway, not when merely opening and quitting the catalog. Viewed pages
  are marked in the current tour's catalog.
- Unknown page ids and excess arguments produce a nonzero standalone exit.
- Input closure, Ctrl+C and normal exit dispose all playback timers and restore
  terminal input in `finally`. Pasted text never acts as tour navigation.

## Layering

```text
lib/tour/
├── run-tour.js        # TUI lifecycle, TourScreen component, key wiring
├── player.js          # playback state machine, injected clock, catalog
├── stage.js           # pure stage state machine (begin/settle/tick/rebuildTo)
├── render.js          # stage + player state -> lines (frame, caption, status)
├── transcript.js      # fictional events -> live CLI transcript controller
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
`submit`, `result`, `slash-result`, `tool`, `assistant`, `menu`, `turn-done`,
`exit`, `note`, `info`, `close-menu`, `consume`, `turn-start`, `expand-tools`,
`prefill`.

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
  `note` step waits for Space/Enter. The final note is also the completed page's
  takeaway; it remains visible instead of being replaced by a generic end card.
- `info` updates displayed model/session/theme state; `close-menu` explicitly
  demonstrates Enter confirmation or Esc cancellation. `turn-start` represents
  commands such as `/init` and `/team add` that launch a model turn.
- `consume` moves queued/steering input into the transcript. `turn-done` does
  not discard pending input. `prefill` demonstrates the editable user message
  restored by `/fork`, which branches **before** the selected user message.
- Completed shell/session segments preserve chronological ordering across exit
  and restart. `transcript.js` sends the staged blocks through
  `createCliOutputController`: startup, user input, assistant messages, tool
  requests/results and completion logs use the live CLI's component assembly.
  This includes leading blank rows, paragraph/code spacing, trimmed log endings,
  background status, file diffs and expanded output. Tool animation is disabled
  for these render-only snapshots, so no live interval timers are created.
- Assistant blocks track completion separately from reveal position. Incomplete
  Markdown remains streaming; table candidates and code fences are finalized
  only when the assistant step finishes, just as in the live event pipeline.

Timing at 1× lives in `TIMING` (player.js): `shell` 24ms/grapheme,
`type` 35ms/grapheme, `assistant` 3 graphemes/30ms. Replies remain visible for
1.8s after streaming; menus move every 650ms and hold for at least 1.8s.
New inline captions extend the hold based on their text length. Explicit notes
wait as long as the reader needs. `speed ∈ {0.5, 1, 2, 4}` scales delays and
clamps at either end. Notes, help, paused pages and completed pages stop timers.
When the next scene is an explanation, its reading countdown is omitted:
the finished animation and any intervening instant updates (such as expanding
tools or printing completion) lead directly to the explanation. Resuming a
reviewed step follows the same rule. Automatic countdowns always lead to
playback or completion, never directly to an explanation pause.

The guide has a red, bold pause pictograph and explicit playback banner:
`⏸ PAUSED · Read this explanation`
waits for Space/Enter, `PAUSED · You paused playback` waits for Space to resume,
and `AUTO · next step in 2.4s` is a reading hold that advances on its own.
`PLAYING` identifies animated demonstrations; `COMPLETE` identifies the final
takeaway. These labels remain legible without color. The footer puts `Step 7/20`
and a progress track before speed/help, even at 36 columns.

Automatic holds use the same monotonic deadline as playback, refreshed while
the simulated Rind is idle as well as running. Pausing/help freezes the remaining
time; resuming preserves it. Speed changes scale the remaining time, not the
entire hold. Tests inject `now` together with `schedule`/`cancel`.

## Keys

| Key | Page view | Catalog |
| --- | --- | --- |
| space | pause / resume / continue a note / next page at the end | — |
| ← / → | back one step and pause for review / skip to the next | — |
| enter | finish animation; if settled, advance; at end, next page | play selection |
| ↑ / ↓ | faster / slower (clamped) | move selection (wraps) |
| r | replay the page | — |
| PgUp / PgDn | scroll the demo, pausing playback | — |
| ? | help (pauses; restores prior playback state on close) | help |
| q / esc | back to catalog | quit |
| ctrl+c | exit tour immediately | quit |

Right while paused displays the next settled step and stays paused; Space
resumes. Opening a different page always starts fresh playback. At the last
page, Enter returns to the catalog.

## Rendering contract

- The stage stores raw data only (raw markdown, raw tool outcomes, raw menu
  specs); the live transcript controller and components style it at render time.
- With no visible simulated content (including prior session history), use a
  `TOUR` card with the lesson title, introduction and start action inside it.
  Readiness has no pause icon, countdown, speed or progress bar; the footer
  keeps the step count, contents and help. This depends on content rather than
  step number, so rewind and replay restore the introduction automatically.
  Padding adapts to terminal height; longer introductions scroll from the top
  with PgUp/PgDn while the action stays visible. Help and resizing preserve readiness.
- The simulated terminal sits inside a `┌─ Demo · <title> ─…┐` panel, ending
  with a complete bottom border. Guidance never appears inside that panel.
  `TOUR GUIDE` starts a separate region with a blank gap on taller terminals;
  its status, caption and controls stay visible. A bounded viewport follows
  the transcript. PgUp/PgDn reviews earlier content. Open menus take focus so
  old transcript does not hide their choices. Content wraps before cursor and
  viewport coordinates are computed. The catalog windows rows and omits page
  ids from narrow list rows (the selected id remains below the list).
- Supported layout starts at 36×14. Smaller terminals pause and show a resize
  prompt. The theme lesson previews Latte only during rendering and restores
  the caller's theme; it never saves a theme preference.
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
virtual terminal (`tour-tui.test.js`), and the in-session stop/run/replay recovery
of the main transcript (`tour-insession.test.js`). `tour-transcript.test.js`
compares every rendered row against real CLI events at three widths, including
blank rows and partial table/code streams. Layout and virtual-terminal tests
assert that pause/completion states and instructions remain outside the closed
demo frame, including in monochrome and after resizing. Every authored step is checked
at 80×24, 60×20, 40×16 and 36×14. Content tests compare animated and rebuilt
states for all pages and reject unfinished turns, lost pending input, or typing
through an open menu.
Playback tests run every lesson at 0.5×, 1× and 4× to verify countdown transitions.
Team content uses the runtime's default `agents/<id>/` workspaces, `.aiteam/`
configuration directories and `shared/` files for handoffs between agents.
Introduction tests cover every lesson in monochrome, content-based layout
selection, overflow, help, resizing, start, rewind and replay in a virtual terminal.
