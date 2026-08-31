# Rind Web Surface Design Spec

## Direction

Operational worker console: dense enough for repeated agent work, calm enough for long sessions, and explicit about the boundary between browser connection and the long-lived worker. The product surface is code-native; it does not need decorative raster art. The existing Rind mark is the only image asset.

## Layout

- Top bar: Rind identity, editable WebSocket endpoint, connection state.
- Left rail: recent sessions and new-session action.
- Center: live transcript, assistant streaming, tool calls, plan state, and fixed composer.
- Right rail: worker/session metadata, model and effort controls, context usage, goal, compact action.
- Mobile: session rail becomes a compact top section; inspector hides; conversation and composer remain fully usable.

## Tokens

- Background: `#090e13`; surfaces: `#101821`, `#151f2a`.
- Structure: `#263541` and `#38505c`.
- Text: `#e8eef2`; muted: `#8797a1`; dim: `#5d6b73`.
- Primary accent: amber `#f3bd65`; secondary accent: cyan `#73d8d2`.
- Semantic states: green `#8ad59d`; error `#f28f86`.
- Typography: Manrope for UI, DM Mono for protocol/state details.

## Core States

- Connecting, connected, disconnected, and manually closed browser connection.
- Empty session, historical replay, live assistant stream, running/completed/failed tools.
- Active plan, token/context usage, goal state, user-question modal.
- Active turn with steering input and cancel; compaction progress and completion.

