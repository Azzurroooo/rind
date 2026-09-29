# Web and desktop design system v2

Scope: `frontend-web/` and `desktop/` only. The Python Worker, CLI and messaging gateway are
not changed. Both surfaces keep runtime protocol v2 and reach feature parity with the CLI
where the runtime exposes the capability.

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
- Header (44): session title (truncate, max 360), status chip, and right-aligned icon
  buttons (28 square, 16px glyphs): tasks, inspector toggle, overflow menu.
- Conversation column: `min(800px, 100%)` centered with 16 inline padding. It keeps at least
  420px when the inspector is open; the inspector closes first when space runs out.
- Inspector: tabs for Context, Tasks, Files, Goal, and Usage. It is dismissible, and its width persists.
- Mobile (< 768): the sidebar and inspector become exclusive drawers (320, scrim
  `#0008`), and the header grows to 48 with 36 icon blocks.

## 3. Sidebar

- Top: project selector (32 row, folder icon, chevron) and a New session icon button.
- Search field (32, 14px search prefix icon, `Ctrl/Cmd+K` also opens the command palette).
- History grouped by time: Today, Yesterday, Previous 7 days, Previous 30 days, then month
  names. Group labels are 12px, `--dim`, weight 600, 8px top padding, 28 high.
- Rows are 32 high with 6 radius and 8 inline padding. Hover is `--fill-1`; active is `--fill-2` with
  `--text` weight 500. A running session shows a 12px spinner before its title.
- Row actions: a 24 square overflow button at the right edge, opacity 0 until row hover,
  focus-within, or open menu. The title fades with a mask
  (`linear-gradient(90deg,#000 calc(100% - 48px),transparent calc(100% - 24px))`) instead of a
  covering plate. Menu items: Fork, Export replay, separator, Delete (danger, confirms).
- Footer: Settings (and Remote access on Desktop) as 32 rows.

## 4. Conversation

- Message wrapper: 8 vertical padding and a 24 gap between turns.
- User: right-aligned bubble with `--surface-soft`, radius 14 (4 on the top-right corner),
  padding 10/14, max-width 80%, `white-space: pre-wrap`, `dir=auto`. Attachment chips go above.
- Assistant: no bubble, full-width markdown, 15px/1.7.
- Action bar under each message: 28 icon buttons, gap 4, `--dim` ink, opacity 0 and fading
  in over 150ms on hover or focus-within. It stays visible while its menu is open and on the latest
  assistant message. Assistant: Copy, Fork from here (when supported), time label. User:
  Copy, Edit & resend (restores text into the composer).
- Streaming: a blinking 2×14 caret at the end of the text, plus a shimmer on the "Working…" line.
- Errors: a `--danger-soft` block with a `--danger` 1px left rule, radius 6, and a Retry action.
- Scroll: stick to the bottom while streaming. When the user scrolls up, a round 32 "Jump to latest"
  button appears at bottom center, 16 above the composer.
- Empty state: the welcome heading (24, weight 600) sits optically centered in the column, with
  the composer directly below and 3–4 suggestion chips that fill the composer rather than send.

## 5. Tool calls (inspector rows)

- One collapsible row per call, 32 high, radius 6, hover `--fill-1`.
- Title: status icon (14), tool name in 12px mono `--muted`, then a keyword chip (the path,
  command or query extracted from the input), then the duration on the right in `--dim`.
- Status: running (spinner), success (check, `--success`), error (x, `--danger`),
  waiting on user (hand, `--info`), cancelled (ban, `--dim`).
- Expand rules: auto-expand while input is streaming (`tool_input_delta` preview) and while
  awaiting a user answer. Collapse automatically on success, and stay open on error. A tool
  is "running" only until its own result arrives.
- Body: arguments (compact key/value, raw JSON behind a toggle), progress lines
  (`tool_progress`), then the result (truncated at 40 lines with "Show all").
- Consecutive calls in one turn fold into a "N steps" group when there are more than 3.
- Retry notices (`turn_step_retry`) and compaction notices (`context_compacted`) render as
  centered 12px system lines with a thin rule.

## 6. Composer

- Frame: `--surface`, 1px `--line-strong`, radius 14, shadow none. Focus-within draws a 3px
  `--accent-soft` ring. Drag-over draws a dashed `--accent` border with the label "Drop files".
- Queue tray: attached above the frame (radius 14 14 0 0, `--panel`). Each queued item is a 32 row
  with Promote (send as steer), Edit (restore to composer) and Remove.
- Textarea: 15px, 12/14 padding, auto-grow up to 40vh, then scroll. Enter sends, Shift+Enter
  inserts a newline, and IME composition is guarded. ArrowUp in an empty composer recalls the last prompt.
- Attachment strip: 28 chips, radius 6, max 180 wide, with a remove button.
- Toolbar (8 padding, gap 4): left side has Attach and Commands (`/`); right side has the model chip,
  effort chip, context meter ring (16, shows the percentage used, and a click opens the Context tab),
  then Send (32 square, `--accent`), which becomes Stop (square icon, `--danger` ink on
  `--danger-soft`) while a turn is running. While running, Enter queues a follow-up and
  Alt+Enter sends it as steering.
- Slash menu: popover above the composer, 10 radius, rows 32, keyboard navigable. Its list
  comes from the runtime command catalog merged with local commands.

## 7. Overlays

- Menus: `--surface`, 1px `--line`, radius 10, padding 4, popover shadow, 32 rows radius 6,
  danger items in `--danger`.
- Dialogs: scrim `#19241e66` with 2px blur. Panel radius 14, padding 20, max-width 520
  (settings 760 × 560), fade plus scale .97 → 1 over 180ms, close button 28 at top-right.
  Esc closes, and focus is trapped and restored.
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
| `/context`, `/fork`, `/model`, `/effort`, `/goal`, `/theme` | | add missing | add missing |

Web shows provider auth status read-only: provider credentials stay managed on the host,
consistent with the existing remote-access security model.

## 9. Code health

- No source file over 800 lines. Split `desktop/src/renderer/index.ts` and
  `frontend-web/src/App.jsx` by feature (shell, sidebar, conversation, composer, inspector,
  dialogs, runtime wiring).
- Delete superseded styles, tokens and components in the same commit that replaces them.
- Keep one slash-command parser per surface; build command lists from the runtime catalog.
