# Rind Mobile

## Scope and architecture

Rind Mobile is an Android/iOS remote client. The phone never runs Python, a model
provider, shell commands or workspace tools. It connects to an authenticated
Desktop Gateway or a standalone Web Worker. Closing the app does not cancel work.

`mobile/` packages the existing React surface with Capacitor. Conversation, tools,
queues, questions, tasks, files, model selection and settings are shared directly
with `frontend-web/src`, not copied. A small surface adapter supplies the remote
endpoint, credential store, ticket HTTP transport, lifecycle and export behavior.
Web retains its same-origin connection and tab-scoped credentials.

Mobile adds a saved-computer list, QR/link/manual pairing, native secure credential
storage, app lifecycle reconnection, system sharing and Android back handling.
Bundled UI is always local; remote hosts cannot supply code to the native bridge.
Pairing input is displayed for confirmation before a connection is made.

## Design and reference study

The authority is `surface-design-v2.md` and the existing Web components: Manrope,
DM Mono, warm light/deep green dark surfaces, green accent and Lucide icons.
Mobile connection screens use the same tokens, controls and restrained spacing.
The conversation keeps the established narrow-screen navigation and inspector.
Safe areas, keyboard resizing and touch targets are explicit mobile concerns.

Local reference repositories studied on 2026-10-02:

- Jan: `web-app/src/services` (platform/default service boundaries),
  `hooks/useInterfaceSettings.ts` (persisted presentation preferences), and
  `components/ui` (dialog/popover composition).
- LobeHub: `src/styles/global.ts` (dynamic viewport and iOS scroll containment),
  `src/components/server/MobileNavLayout.tsx` and mobile chat routes (compact
  navigation and screen ownership).

These are architectural and interaction references. No source from either project
is vendored; LobeHub has additional license conditions. Runtime and UI reuse comes
from Rind itself and maintained Capacitor plugins.

## Delivery checkpoints

1. Add the shared surface boundary and independent mobile build.
2. Implement pairing, saved hosts, native lifecycle/storage/share and platform projects.
3. Verify gateway authentication, shared surface regressions, mobile interaction,
   production builds and Android packaging; record platform verification limits.

No live provider acceptance or publishing is implicit in this work. Automated
protocol scenarios use isolated fake providers/workspaces.
