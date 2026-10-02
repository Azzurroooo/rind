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

Local reference repositories studied on 2026-10-02 (Jan `8c816cafb`, LobeHub `c3315ed5cb`):

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

## Verification boundaries

The app reuses the actual Web components and token sheets. Browser visual QA uses
the existing Web screen and `surface-design-v2.md` as the reference, not a new
generated design. Reviewed points: typography, light/dark palette, logo/icons,
control size/spacing, connection form, conversation/composer and side drawers.
New copy is limited to computer pairing, connection management and native behavior.

The browser tool was unavailable; Playwright Chromium provided screenshots and
interaction checks. Mobile smoke tests run the production bundle at 320, 390, 430
and 768 px, plus 844×390 landscape and 390×420 reduced-height layouts, against the
real Desktop Gateway and an isolated fake Worker bridge.
They substitute native HTTP/WS-origin transport; this is not camera/keychain or
physical phone acceptance. No real provider tokens are consumed.
The page itself uses Android's `http://rind.local` origin, exercising the absence
of secure-context-only browser APIs. Computer IDs use `getRandomValues`, which
works in this context, rather than `randomUUID`.

## Verified results — 2026-10-02

| Check | Result |
| --- | --- |
| Mobile unit/UI tests | 30 passed across 4 files |
| Mobile production Gateway smoke | Passed pairing/authentication, replay, six viewports, drawers, files/upload, prompt/queue/stop, reconnect/draft retention, theme, credential isolation and forgetting |
| Shared Web regression suite | 385 passed across 43 files; after adding the suspension regression, all 11 runtime-client tests passed |
| Desktop regression suite | 234 passed; TypeScript check passed |
| Python Web transport tests | All 4 in `test/test_web_runtime.py` passed |
| Production bundles | Web, Desktop and Mobile built successfully |
| Native project synchronization | Android and iOS passed |
| Android debug build | `assembleDebug` passed using JDK 21, Gradle 8.14.3 and SDK 36 |
| APK inspection | `aapt` metadata and `apksigner verify` passed; all 29 bundled Web assets match `mobile/dist` and the synced iOS assets |

The locally built debug APK is at
`mobile/android/app/build/outputs/apk/debug/app-debug.apk` (ignored build output):

- Application ID: `dev.rind.mobile`; version `0.9.0-beta.1`, version code `1`.
- Minimum/target Android SDK: 26/36. Camera hardware is optional.
- Size: 36,299,988 bytes; debug signed with APK Signature Scheme v2.
- SHA-256: `a2623b14a287cd75c82e18b1155039312aa93cb7ea13d91c4b5705ef2a25d6c6`.
- Native logging is disabled; assets are bundled locally with no remote
  `server.url`. No Python files are packaged.

This machine has no attached Android device or emulator. iOS plist/privacy
metadata and package references were checked, but Windows cannot compile or sign
the iOS project. Neither platform has passed physical-device acceptance here.
The debug APK is a development artifact, not a store-signed release.

The mobile CI workflow includes Android debug APK compilation and an unsigned iOS
Simulator build. Configuring CI is not evidence that a remote CI run has passed.
Store signing, physical device permissions, QR camera, sharing destinations and OS
keyboard behavior require the corresponding device/build environment.
