# Web and desktop upgrade

## Scope and design

The Python worker and messaging gateway stay unchanged. Both clients retain protocol v2,
existing session history, tools, queued input and cancellation. Desktop owns remote access
and serves the production web client through its own authenticated gateway.

Reference study (local source, 2026-09-29):
- Jan `web-app/src/containers/ThreadList.tsx`, `SettingsMenu.tsx`, `ChatInput.tsx`:
  quiet project navigation, explicit settings, composition-safe input and contextual actions.
- LobeHub `DESIGN.md` and `src/routes/(main)/group/_layout/Sidebar/Topic/TopicListContent/ByTimeMode/GroupItem.tsx`:
  neutral semantic surfaces, 4px spacing, content-first hierarchy and compact history groups.
- These are interaction/design references, not imported implementations or dependencies.

Design specification: neutral white/charcoal canvases, restrained amber brand accent,
14px interface and 15px conversation type, 8–12px controls, 256px navigation, readable
760–820px conversation column. Primary screen: projects/sessions, conversation and composer.
Session details, tasks, goals and files use a dismissible inspector. Connection configuration
lives in settings. Mobile uses exclusive drawers, touch-sized actions and a stable composer.
Empty-state suggestions fill the composer and remain editable. Light and dark have the same
hierarchy. Existing Rind/Lucide vector assets are retained.

## Implementation sequence

1. Web: navigation, session toolbar/settings, task controls and goals; reliable reconnect,
   draft retention, input/attachment handling, keyboard and mobile behavior.
2. Desktop: match visual hierarchy, improve settings and discoverability, session tools;
   add an optional remote-access service under `desktop/src/main/gateway/` and its UI.
3. Gateway: same running Worker, authenticated tickets, same-origin web and WS, bounded
   traffic, session subscriptions, revocation and deterministic shutdown. Off by default;
   explicitly chosen local-network or loopback access. Private HTTPS can terminate in an
   existing tunnel/VPN without adding a cloud account or mandatory relay service.
4. Verify regression suites, production builds, desktop typecheck, isolated gateway
   integration tests and real rendered desktop/mobile light/dark screens. Commit coherent
   stages on `feature/web-desktop-upgrade`.

## Validation boundaries

Use deterministic fake runtime fixtures for client integration and browser checks. No live
provider calls, user credential changes, remote deployment or public tunnel activation.
Keep temporary screenshots and fixtures out of commits. Record final checks below.

## Progress

- Reference study and client/worker capability audit completed.
- Implementation in progress.
