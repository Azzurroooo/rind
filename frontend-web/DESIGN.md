# Rind Web Surface Design Spec

## Direction

Operational worker console: dense enough for repeated agent work, calm enough for long sessions, and explicit about the boundary between browser connection and the long-lived worker. The product surface is code-native; it does not need decorative raster art. The existing Rind mark is the only image asset.

## Layout

- Top bar: Rind identity, editable WebSocket endpoint, connection state.
- Left rail: recent sessions (relative time + reply preview), search, new-session action, read-only file tree.
- Center: live transcript, assistant streaming, tool calls (with run grouping), plan state, turn status line, and fixed composer.
- Right rail: worker/session metadata, model and effort controls, tiered context gauge, goal, compact action.
- Mobile: session rail and inspector become edge drawers behind the compact header; conversation and composer remain fully usable.

## Tokens

- Background: `#090e13`; surfaces: `#101821`, `#151f2a`.
- Structure: `#263541` and `#38505c`.
- Text: `#e8eef2`; muted: `#8797a1`; dim: `#5d6b73`.
- Primary accent: amber `#f3bd65`; secondary accent: cyan `#73d8d2`.
- Semantic states: green `#8ad59d`; error `#f28f86`.
- Typography: Manrope for UI, DM Mono for protocol/state details.

## Core States

- Direct-connect first: a tokenless loopback worker connects with zero friction; only a 4401 close reveals the login card.
- Connecting, connected, reconnecting (auto, capped at 3 attempts), offline (rests quietly with a retry affordance), manually closed browser connection.
- Empty session, historical replay, live assistant stream, running/completed/failed tools.
- Active plan, token/context usage (cyan → amber past 75% → red past 90%), goal state, user-question modal.
- Active turn with steering input and cancel; the single-row turn status carries the elapsed clock, the current activity, and the Esc hint in a fixed slot.

## Interaction Rules (borrowed where noted)

- **The turn feels alive** (codex status widget, claude spinner): one quiet status row — `Working 42s · Shell command $ pytest -q · Esc 中断`; a step-retry strip appears while the model is between attempts and clears itself when text flows again. Tool heartbeats surface on the running tool's status chip.
- **Calm-by-default transcript** (claude code collapse, cline low-stake grouping): runs of ≥3 consecutive completed read/search calls fold into one expandable row; failed, running and mutating tools always stand alone.
- **Queue as first-class objects** (openclaw/opencode): queued inputs render as rows with 取回 / 转向 actions; the kernel snapshot rebuilds them bit-for-bit after a reconnect.
- **Shell input habits** (goose): ↑/↓ recall sent prompts newest-first; navigation starts only from an empty input so the caret is never hijacked.
- **Timestamps read like history, not logs** (goose/crush): the session rail shows `5 分钟前 · preview`; the context meter speaks only when it matters.
- **The console teaches deployment**: with the worker unreachable and nothing to read, the empty state renders the exact startup commands (local `--web` and `docker compose`), copy-ready.
- Reconnects never move the user's place: the first connect adopts the worker's default session; every reconnect keeps the session the user is reading and replays the gap.
