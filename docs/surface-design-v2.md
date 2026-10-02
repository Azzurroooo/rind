# Web and desktop design system v2

Scope: `frontend-web/` and `desktop/`, retaining runtime protocol v2 and the existing
Worker execution flow. UI replay also retains the already-persisted message timestamp
alongside the opt-in message ID; default model-facing projections are unchanged.

The specification is distilled from two mature open-source agent clients and the Rind
website. Values are adopted, not invented; any deviation below states its reason.

- Jan (`ui-open-source/jan/web-app/src`): sidebar mechanics, message layout, composer
  frame, settings layout, dialog and toast behavior.
- LobeHub (`ui-open-source/lobehub`, `DESIGN.md`, `packages/const/src/layoutTokens.ts`):
  4px spacing scale, radius and control-height ladder, fill-alpha hover model, message
  action bar, tool inspector, queue tray, time grouping, motion rules.
- Rind website (`rind-web/src/styles/global.css`): palette and typography.

## 1. Tokens

Components reference tokens only; themes re-tune the token block, never component rules.

### Palette (from the Rind website)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f7f6f0` | `#151d18` | conversation canvas |
| `--panel` | `#efeee5` | `#111914` | sidebar, inspector |
| `--surface` | `#fdfcf8` | `#1a241e` | composer, cards, popovers |
| `--surface-soft` | `#ecebe1` | `#222d26` | user bubble, code header |
| `--line` | `#e1e1d6` | `#2a352d` | default divider |
| `--line-strong` | `#d5d7ca` | `#3d4a3f` | control borders |
| `--text` | `#22271f` | `#ebeee4` | primary ink |
| `--muted` | `#64685e` | `#a5b0a4` | secondary ink |
| `--dim` | `#7d8176` | `#86917f` | tertiary ink (AA on bg) |
| `--accent` | `#334c37` | `#d6df9a` | the single primary action |
| `--accent-contrast` | `#f4f3eb` | `#19241e` | ink on accent |
| `--accent-soft` | `#d6df9a66` | `#d6df9a1f` | selection, focus ring, highlight |
| `--fill-1/2/3` | ink at 3% / 6% / 10% | on-dark at 4% / 7% / 12% | hover / active / pressed |
| `--success` | `#3f7a4a` | `#8fc79a` | |
| `--warning` | `#9a6208` | `#e5b25c` | |
| `--danger` | `#b4452f` | `#ec8a74` | |
| `--info` | `#3a6ea5` | `#8ab4e8` | |

Each status color has a `-soft` background (same hue, ~12% alpha).

### Typography

- UI: `Manrope Variable`, then `"PingFang SC", "Microsoft YaHei UI", system-ui`.
- Code: `DM Mono`, then `"Cascadia Code", Consolas, monospace`.
- Fonts are bundled with `@fontsource` so the Desktop app works offline.
- Sizes: 12 (meta), 13 (dense lists only), 14 (UI body, line-height 22px), 15 (conversation,
  line-height 1.7), 16, 20 (dialog titles), 24 (welcome heading), weight 600 for headings.

### Scale

- Spacing: 4, 8, 12, 16, 20, 24, 32. 8 inside a group, 16 between groups, 24–32 between sections.
- Radius: 4 (chips), 6 (inputs, buttons, rows), 10 (cards, menus), 14 (composer, dialogs),
  9999 (avatars and pills only). The website's 3px is too sharp for dense controls, and
  Jan's 24px composer reads as consumer chat, so these sit between LobeHub and the website.
- Control heights: 28 (compact), 32 (default rows and buttons), 36 (inputs).
- Shadows: popover `0 8px 16px -4px #19241e24`, dialog `0 20px 40px -12px #19241e40`.
  Prefer a border over a shadow when either would work.
- Motion: 120ms hover/state, 180ms popovers and dialogs, 200ms panel width, ease
  `cubic-bezier(0.2, 0.7, 0.2, 1)` (website). Honour `prefers-reduced-motion`.

## 2. App shell

```
| sidebar 264 (232–360, resizable, Ctrl/Cmd+B) | header 44 / conversation | inspector 360 (320–640) |
```

- Sidebar: `--panel` background. Width and open state persist per viewer. Collapse animates
  width over 200ms; transitions are disabled while dragging. The resize handle is a 6px hit
  area with a 1px line that turns `--line-strong` on hover.
- Both sidebars use the shared `panel-scroll` primitive: a thin native scrollbar,
  transparent track, `--line-strong` thumb and stable gutter where the platform reserves
  one. Keep 6px between content and the scrollbar lane, and 6px between the lane and
  the panel edge. Desktop panel shells clip without becoming extra scroll containers;
  focus must not pan the shell sideways. Files retains its independent preview scrolling.
- Header (44): session title (truncate, max 360), status chip, and right-aligned icon
  buttons (28 square, 16px glyphs): tasks, inspector toggle, overflow menu.
- Conversation column: `min(800px, 100%)` centered with 16 inline padding. It keeps at least
  420px when the inspector is open; the inspector closes first when space runs out.
- Inspector: tabs for Context, Activity, and Files. It is dismissible, and its width persists.
  A scope line identifies Context/Activity as the current session, and Files as the workspace.
  Usage is a separate global dialog reached from the sidebar footer (all projects and sessions).
  It includes cache-read tokens and a period-wide cache hit rate (cached input / input),
  using the existing usage ledger. Cache reads are already included in input totals.
  A missing cache field is labeled Not reported; a missing/zero denominator has no rate.
  The period label and Refresh share a dedicated toolbar at least 32px high. Refresh
  has a 28px target, and the toolbar has at least 12px separation from the statistics.
  Hover changes the button fill without moving its bounds or overlapping the next section.
  In Web Files, the directory and preview have independent scroll containers. With a
  preview open, the directory takes about a quarter of the available height and the
  preview takes the remainder, separated by a fixed filename/close header. Closing it
  restores the full directory without losing its position. Late reads cannot replace
  a newer selection or reopen a closed preview.
  The Activity tab is one scrollable column — after LobeHub's WorkingSidebar overview — stacking the
  live plan checklist, background commands the agent yielded that are still running, and an existing
  goal with a compact section head. Render only populated sections, plus task failures or a pending
  background wait. There is no plan deck beside the composer: `update_plan` state lives in Activity.
  Goal creation and replacement use `/goal <objective>` only. The sidebar has no objective field,
  create button or clickable goal heading. Existing goals retain Pause / Resume / Clear; empty goals
  occupy no space. Desktop's redundant composer-menu and palette creation actions are removed.
  When every section is empty, show one unframed, centered state with 48px top padding: a muted
  28px ListTodo icon, 14px/600 heading, 12px explanation limited to 28ch, and subdued `/goal` guidance.
  New conversations say "No activity yet"; existing sessions say "No active work" and explain where
  completed output stays. Initial task loading is distinct, but background revalidation keeps the
  settled empty state. Errors and pending tasks never disappear behind the empty-state guidance.
  Tasks are keyed by task/background ID: updates replace the existing row. Revalidation keeps
  prior output, focus, expansion, history cursor, and scroll position. Poll only while visible;
  isolate late responses when the viewed session changes.
- Mobile (< 768): the sidebar and inspector become exclusive drawers (320, scrim
  `#0008`), and the header grows to 48 with 36 icon blocks.

## 3. Sidebar

- Top: project selector (32 row, folder icon, chevron) and a New session icon button.
- Search field (32, 14px search prefix icon, `Ctrl/Cmd+K` also opens the command palette).
- Projects appear above Recent sessions, with distinct headings and a dividing rule.
  Recent is one chronological list with no date groups. Opening a conversation and
  conversation activity both count as interaction; the latest timestamp determines order.
  Both surfaces initially show 10 recent sessions and load more on demand. Desktop pages
  the project store; Web increases the worker's list limit in steps of 10 (worker maximum 100).
  The Web project selector shows the selected folder on the Rind computer. New session
  uses this confirmed folder, never an unsubmitted path draft or the phone's filesystem.
- Rows are 32 high on Desktop and 36 on Web, with 6 radius and 8 inline padding.
  Hover is `--fill-1`; active is `--fill-2`. A running session shows a compact spinner.
- Row actions: a 24 square overflow button at the right edge, opacity 0 until row hover,
  focus-within, or open menu; always visible on touch. Reserve its space at rest, after
  Jan's sidebar menu action, so revealing it never changes the title width. Truncate
  long titles with an ellipsis; never mask the title or cover short text with a gradient.
  Keep the Web list's grid track shrinkable (`minmax(0, 1fr)`), so long titles cannot
  widen the list or make focusing the menu scroll short titles out of view.
  Menu items: Fork, Export replay, separator, Delete (danger, confirms).
- Pagination: a 32px secondary button inset 8px from the list edges, with centered
  muted 12px/500 text, a fine `--line` border, `--fill-1` background and 6px radius.
  It must read as an action distinct from the left-aligned session titles. No idle
  icon or disclosure chevron: pagination appends sessions rather than expanding a
  menu or directory. Hover strengthens the border and fill; pressing changes fill
  only. Loading adds a 12px spinner beside the label without changing button bounds,
  marks the button busy and disables repeat requests. Both project and recent
  pagination use this same control.
- Footer: global Usage; Web also has Settings. Desktop settings and remote access stay in its top bar.

## 4. Conversation

- Message wrapper: 8 vertical padding and a 24 gap between turns.
- User: right-aligned bubble with `--surface-soft`, radius 14 (4 on the top-right corner),
  padding 10/14, max-width 80%, `white-space: pre-wrap`, `dir=auto`. Attachment chips go above.
- Assistant: no bubble, full-width markdown, 15px/1.7.
- Action bar under each message: 28 icon buttons, gap 4, `--dim` ink, opacity 0 and fading
  in over 150ms on hover or focus-within. It stays visible while its menu is open and on the latest
  assistant message. Assistant: Copy, Fork from here (when supported), time label. User:
  Copy, Edit & resend (restores text into the composer), time label. System/command
  messages also offer Copy and time. Use semantic `time` with local hour/minute and
  a full date/time/timezone tooltip. Reserve action-row space so hover never shifts
  content; touch devices keep it visible. Read the event/persisted timestamp, and
  explicitly show “Time unavailable” for legacy messages without one.
- Streaming: a blinking 2×14 caret at the end of the text. The session header retains its status.
  A permanent 26px composer context row also shows the working folder and Ready / Working /
  Your input needed / Compacting. Its three dots animate with opacity and transform only;
  reduced-motion keeps a static indicator. Starting or finishing never inserts a transcript row.
- Errors: a `--danger-soft` block with a `--danger` 1px left rule, radius 6, and a Retry action.
- Scroll: stick to the bottom while streaming. When the user scrolls up, a round 32 "Jump to latest"
  button appears at bottom center, 16 above the composer.
- Empty state: the welcome heading (24, weight 600) sits optically centered in the column, with
  the composer directly below and 3–4 suggestion chips that fill the composer rather than send.

## 5. Tool activity

Tool output is the noisiest part of an agent transcript. Show what the user needs to judge
progress and outcome, fold everything else, and never print raw payloads by default. This
mirrors LobeHub's `WorkflowCollapse` / `ProcessFold` and the CLI's per-tool caps
(`frontend-cli/lib/tool-display.js`).

### 5.1 Activity folding (between messages)

- Keep tool work visually secondary: one `--fill-1` surface with a 1px `--line`
  boundary, 9px radius, 3px inset, 12px summary, muted completion icon and 16px
  separation below. Align it to the same reading column as prose. Both single
  and grouped calls retain this container through running/completed transitions.
- A *work segment* is every tool call, reasoning line, retry notice and progress line that
  sits between two pieces of visible prose (a user message or assistant text). All tool batches
  in one segment render as a single fold, never as separate stacked cards.
- Collapsed fold (32 row): status icon, then a generated summary such as
  `Read 4 files, searched 2 patterns, ran 3 commands, edited app.ts +12 -3`, then the total duration
  on the right. Verbs are grouped by tool kind, counts are merged, and failures are appended
  as `1 failed` in `--danger`.
- While the segment is live, the fold is open and shows only the running call plus the last
  2 finished calls, with a "+N earlier" link above. When the segment ends it settles for
  600ms, then collapses to the summary with a 220ms height/opacity transition, unless a
  call failed or is waiting on the user. A renewed live phase cancels the pending fold.
  Manual expansion and interaction with a tool keep the fold open. Repeated stream
  updates preserve the shell and keyed tool rows, including focus and scroll position.
  Collapsed content is inert; reduced-motion suppresses transitions.
- Expanded fold: one 28 row per call (5.2), with no body unless the row itself is expanded.
- A segment with a single call visually shows just that row. Its stable shell remains
  mounted so a second call can reveal the summary without replacing the first row.
- Background Task snapshots (`task_updated`, including `on_exit`) belong in Activity.
  They do not add system cards to the transcript; actual tool output and failures remain.

### 5.2 Call row

- 28 high, radius 6, hover `--fill-1`. It shows the status icon (14), a verb label (not the raw tool
  name), the key target in 12px mono (paths truncate from the start), the tool-specific meta on the
  right in `--dim`, and a chevron only when there is a body worth opening.
- Status: running (spinner), success (no icon inside collapsed folds, a check when expanded),
  error (x, `--danger`), waiting on user (hand, `--info`), cancelled (ban, `--dim`).
- A call is "running" only until its own result arrives.

### 5.3 Per-tool rendering

| Tool | Label + target | Meta | Body (on expand) | Never show |
| --- | --- | --- | --- | --- |
| `read_file` | Read `path` | line range or `N lines` | none; clicking opens the file in the Files tab | file contents |
| `write_file` | Wrote `path` | `+N` | highlighted content, 20 lines then "Show all" | argument echo |
| `edit_file` | Edited `path` | `+A -R` in success/danger | unified diff hunks, 20 lines collapsed | old/new string JSON |
| `grep` | Searched `pattern` | `N matches in M files` | paths with match counts; lines on demand | raw output; 0 matches shows "No matches" |
| `glob` | Found `pattern` | `N files` | path list, 20 then "Show all" | |
| `bash` | Ran `command` (first line) | exit code if non-zero, duration | terminal block: last 5 lines live, 5 collapsed, 400 expanded | empty stdout/stderr sections |
| `bash_output`, `task_control` | Checked / Stopped `task label` | status | latest output tail, 5 lines | |
| `search_web` | Searched the web `query` | `N results` | title + domain list | raw JSON |
| `fetch_web_page` | Read `domain/path` | page title | title and first paragraph | full page text |
| `delegate` | Delegated to `agent`: task summary | status, duration | the sub-agent's final answer (markdown, 24 lines) | internal transcript |
| `agent_create`, `skill_create` | Created agent / skill `name` | | name and role / description | |
| `ask_user_question` | no row; the interactive question card renders inline | | | |
| `update_plan` | no row; updates the plan checklist in the inspector's Activity tab | | | |
| `update_goal` | Updated goal | status | goal text | |
| unknown tools | `tool_name` | | key/value arguments, result truncated at 40 lines, raw JSON behind a toggle | |

- Streaming input (`tool_input_delta`): the row appears immediately and its target fills in as
  the arguments parse; `write_file` and `edit_file` stream their content into the body.
- `tool_progress` replaces the meta text; it does not append lines.
- Errors: the row stays expanded and shows the error message (first 6 lines) in `--danger-soft`. Stack
  traces go behind "Show details".
- Retry notices (`turn_step_retry`) and compaction notices (`context_compacted`) render as
  centered 12px system lines with a thin rule, outside folds.

## 6. Composer

- Frame: `--surface`, 1px `--line-strong`, radius 14, shadow none. Focus-within draws a 3px
  `--accent-soft` ring. Drag-over draws a dashed `--accent` border with the label "Drop files".
- Queue tray: attached above the frame (radius 14 14 0 0, `--panel`). Each queued item is a 32 row
  with Promote (send as steer), Edit (restore to composer) and Remove.
  A running turn must not hold the composer preparation lock. Steer is in Message actions
  beside the primary send control; Alt+Enter remains supported.
  Inputs are reconciled by ID across local confirmation and remote delivery; reconnect
  rebuilds the transcript from worker history.
- Textarea: 15px, 12/14 padding, auto-grow up to 40vh, then scroll. Enter sends, Shift+Enter
  inserts a newline, and IME composition is guarded. ArrowUp in an empty composer recalls the last prompt.
- Attachment strip: 28 chips, radius 6, max 180 wide, with a remove button.
- On phones, attachment and command buttons stay on one row. Model/effort labels shrink
  before actions do; popovers use the input frame's available width, including while a queue
  and draft are present. At 380px and below, model/effort/context have their own permanent
  row, with Attach/Commands and Send below. Model/provider labels truncate inside the list.
- Toolbar (8 padding, gap 4): left side has Attach and Commands (`/`); right side has the model chip,
  effort chip, context meter ring (16, shows the percentage used, and a click opens the Context tab),
  then a fixed-width send control: Send while idle, Stop when running with an empty draft,
  and Send after this turn when running with text. The adjacent chevron opens Queue,
  Steer and Stop, so Stop stays available with a draft. Enter queues; Alt+Enter steers.
  Idle keeps the chevron slot (disabled), preventing a toolbar shift. During compaction
  the input remains editable, submission waits, and Stop remains available.
- Model picker (after Jan's provider groups and LobeHub's ModelSwitchPanel): the chip opens a
  popover above the composer whose rows come from the runtime's `model/list` grouped by provider —
  uppercase group headers with the provider display name from `rind/auth/list` and a count, then
  model ids in mono with the context window ("128K ctx") and an image marker where known. More than
  8 models adds a filter box at the top. Selecting sends `provider_id` with `model_id` so identical
  ids across providers cannot collide. Both surfaces use a check column, CPU/brain chip icons,
  the same effort labels (Low / Medium / High / Extra high / Max), UI font for effort and
  mono for model identifiers. Menus support arrows, Escape and outside-pointer dismissal.
  Both surfaces offer the provider-aware runtime catalog and effort before the first
  message. No-session choices stay in the draft; session creation applies provider,
  model and effort before submitting. Refreshing the catalog preserves those choices,
  and selecting in the composer never changes the saved default configuration.
  Model/effort changes are disabled during a running turn on both surfaces.
- Working folder: the context row stays visible when navigation is closed. Web shows the
  folder name with a tap-to-expand full path labeled "Folder on Rind computer"; Desktop
  shows its path and retains project selection before a session starts. The whole
  path control, including truncated text, fits within its padded hover/focus background.
- Desktop questions: a neutral surface with a small "Your input needed" heading, native
  radio rows, optional custom textarea and Send answer. Selection does not submit. Keep
  the form and draft until confirmation, disable duplicate submissions, and show retryable
  errors in place. Streaming events do not replace controls or disturb input selection.
- Slash menu: popover above the composer, 10 radius, rows 32, keyboard navigable. Its list
  comes from the runtime command catalog merged with local commands. Filter
  `config/context/doctor/login/logout/model/effort/session/sessions/theme` and terminal-only
  commands, including aliases. The execution path accepts only this filtered catalog;
  unknown input cannot bypass it through a runtime fallback. Settings and navigation
  remain available in the UI/palette. Help lists actual slash forms only.
- `/status` renders the CLI's `entries` and `usage` payload as a session snapshot:
  settings state, endpoint, API-key presence (never the key), model/effort, then the
  latest response's context meter, input/capacity, cached input and hit rate, and output.
  An absent sample is explicitly distinguished from zero cache hits. Values wrap on
  phones; global Usage remains a separate destination.

## 7. Overlays

- Menus: `--surface`, 1px `--line`, radius 10, padding 4, popover shadow, 32 rows radius 6,
  danger items in `--danger`.
- Dialogs: scrim `#19241e66` with 2px blur. Panel radius 14, padding 20, max-width 520
  (settings 760 × 560), fade plus scale .97 → 1 over 180ms, close button 28 at top-right.
  Esc closes, and focus is trapped and restored.
- Keyboard shortcuts has one named close icon in its header, with no duplicate footer
  Close action. Its heading labels the dialog; Escape remains supported.
- Desktop command-palette rows place title and subtitle in one copy column with a 4px
  gap, independently of the trailing shortcut column. Rows retain their natural content
  height in the scrolling list; shortcut presence cannot change spacing or clip a subtitle.
- Settings: 200 left nav (32 rows, 16 icons) and a content pane of titled sections, each made of
  rows (label and description on the left, control on the right, 1px `--line` between rows).
- Toasts: bottom center, `--surface`, radius 10, popover shadow, 4s, at most 3 stacked.
- Tooltips: `--text` background with `--bg` ink, 12px, radius 6, 400ms delay.

## 8. Capability parity with the CLI

| Capability | Runtime | Web | Desktop |
| --- | --- | --- | --- |
| Context meter and inspect | `rind/context`, `rind/context/inspect`, `context_built` | add | add event |
| Compaction feedback | `context_compacted` | add | add |
| Usage summary | `rind/usage/summary` | add | keep |
| Background processes | `rind/background/list`, `output`, `background_wait_changed` | add | add event |
| Streaming tool input, progress, retry | `tool_input_*`, `tool_progress`, `turn_step_retry` | add | keep |
| Provider auth | `rind/auth/list`, `login`, `logout`, `prompt`, `update` | status only | full |
| Task continuation failure | `task_continuation_failed` | keep | add |
| Slash catalog | runtime catalog plus local commands | from runtime | from runtime |
| Conversational slash actions: `/fork`, `/goal`; settings/navigation use GUI entries | | aligned | aligned |

Web shows provider auth status read-only: provider credentials stay managed on the host,
consistent with the existing remote-access security model.

## 9. Code health

- No source file over 800 lines. Split `desktop/src/renderer/index.ts` and
  `frontend-web/src/App.jsx` by feature (shell, sidebar, conversation, composer, inspector,
  dialogs, runtime wiring).
- Delete superseded styles, tokens and components in the same commit that replaces them.
- Keep one slash-command parser per surface; build command lists from the runtime catalog.
