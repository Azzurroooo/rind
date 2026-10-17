# Rind Web & Desktop Surface Design Spec

## Direction

Operational multi-agent workbench: dense enough for repeated agent engineering and multi-agent team coordination, calm enough for long sessions, and explicit about the boundary between surface connections, the shared Python runtime, and the Team Agents Management daemon. The product surface is code-native and preserves the restrained **Warm Botanical Paper & Deep Forest Ink** aesthetic (`Manrope Variable` + `DM Mono`).

## Layout & Native Multi-Agent Workbench

Inspired by **Orca**, **Paperclip**, **Jan**, and **LobeHub**, Team Agents Management is woven directly into the primary application shell rather than isolated in a disconnected modal:

- **Top bar**: Rind identity, active surface / session title, agent context breadcrumb (`Team / Agent · Role`), running status indicator, and quick actions (Command Palette, Remote Access, Theme, Sidebar, Inspector).
- **Left rail (Unified Navigation)**:
  - **Global Multi-Agent Surfaces**: `Inbox & Approvals` (with live badge count), `Manager Agent` (direct chat with the global coordinator), and `Background & Runtime` (with active run count).
  - **Teams**: Expandable team hierarchy showing each team, quick `Board` launcher, and member roster with live semantic status dots (`Working`, `Needs input`, `Delegated`, `Idle`), roles, and `Lead` tags. Clicking a member opens their direct chat session; clicking a team opens the Team Surface.
  - **Independent Workspaces**: Registered local project folders and recent sessions.
- **Center Stage (Context-Switched Canvas)**:
  - **Conversation Stream (`chat`)**: Live transcript, assistant streaming, syntax-highlighted code blocks with copy header, folded work segments, rich tool cards (`delegate`, `report`, `agent_management`), `Team delivery` message badges, expandable `EditedFilesCard` (`Changed N files +A -R`), right-edge `ChatMiniMap` turn landmarks, floating text-selection `Quote` pill, and fixed composer.
  - **Team Surface (`team`)**:
    - `Organization & Hierarchy`: Interactive reporting tree (`Leader -> Specialists -> Sub-reports`) with live task cards, workspace/worktree badges, and inline member/leader management.
    - `Tasks & Deliveries`: 4-column semantic Kanban board (`Queued`, `In Progress`, `Needs Review / Input`, `Completed`) and grouped list view with assignee filter chips and slide-over `TaskReportDrawer` for delivery acceptance/rework, blocker answers, and artifact previews.
  - **Inbox Surface (`inbox`)**: Unified human-in-the-loop triage for approvals (`deleteTeam`, `cancelRun`), blocked user questions, completed task deliveries awaiting review, unconfirmed runs, and team notices.
  - **Background Surface (`background`)**: Shared Python Runtime and Management Service health cards, active and recent delegated runs, and live service/runtime/run log inspection.
- **Right rail (Inspector with Glide-Maximize)**:
  - Dismissible, resizable, and expandable (`Maximize2` / `Minimize2`) right column with `Context`, `Activity` (live plan, background commands, session goal, and active team roster), `Files`, and `Team` (in Web) tabs, plus the global `Usage` dialog.

## Tokens

- **Light (`Warm Botanical Paper`)**:
  - Background: `#f7f6f0`; panel: `#efeee5`; surface: `#fdfcf8`; soft surface: `#ecebe1`.
  - Structure: `#e1e1d6` and `#d5d7ca`.
  - Text: `#22271f`; muted: `#64685e`; dim: `#7d8176`.
  - Accent: `#334c37` (`--accent-contrast: #f4f3eb`, `--accent-soft: #d6df9a66`).
- **Dark (`Deep Forest Ink`)**:
  - Background: `#151d18`; panel: `#111914`; surface: `#1a241e`; soft surface: `#222d26`.
  - Structure: `#2a352d` and `#3d4a3f`.
  - Text: `#ebeee4`; muted: `#a5b0a4`; dim: `#86917f`.
  - Accent: `#d6df9a` (`--accent-contrast: #19241e`, `--accent-soft: #d6df9a1f`).
- **Semantic states**:
  - Success / Completed: `#3f7a4a` (light) / `#8fc79a` (dark)
  - Warning / Needs Attention: `#9a6208` (light) / `#e5b25c` (dark)
  - Danger / Error: `#b4452f` (light) / `#ec8a74` (dark)
  - Info / Working: `#3a6ea5` (light) / `#8ab4e8` (dark)
- **Typography**: `Manrope Variable` for UI, `DM Mono` for code, paths, and protocol/state details.
