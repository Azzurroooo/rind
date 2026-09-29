# Web and desktop upgrade

Completed on 2026-09-29 on `feature/web-desktop-upgrade`. The Python Worker, CLI, and existing
messaging gateway are unchanged. Both surfaces continue to use runtime protocol v2.

## Design and reference study

Local references:

- Jan (`E:/code/agent1/ui-open-source/jan`): `web-app/src/containers/ThreadList.tsx`,
  `SettingsMenu.tsx`, `ChatInput.tsx`. Applied quiet project navigation, explicit settings,
  composition-safe input, and contextual session actions.
- LobeHub (`E:/code/agent1/ui-open-source/lobehub`): `DESIGN.md` and
  `src/routes/(main)/group/_layout/Sidebar/Topic/TopicListContent/ByTimeMode/GroupItem.tsx`.
  Applied neutral semantic surfaces, a 4px spacing rhythm, content-first hierarchy, and
  compact time groups in Web history.
- These are design and interaction references, not imported implementations or dependencies.

The specification uses white/charcoal canvases, a restrained amber accent, 14px primary UI
text, 15px conversation text, 8–12px control corners, 256px navigation, and a readable
760–820px conversation column. Secondary details are dismissible. Mobile navigation and
details use exclusive drawers. Suggestions fill the composer and remain editable.

Connection is automatic. Web has no address field in its header, login, or settings; legacy
`?ws=` and browser-stored address overrides are ignored. Deployment owners can still configure
`VITE_RIND_WS_URL` at build time. Existing Rind and Lucide vector assets are retained; no new
raster illustrations or generated concept images were used. Rendered QA follows this written
specification and the reference study, rather than claiming a pixel match to a concept image.

## Delivered capabilities

| Area | Web | Desktop |
| --- | --- | --- |
| Navigation | Project selector, grouped history, search, mobile drawers | Native project folders, session search, recent/project navigation |
| Conversation | Streaming, queue/steering, stop, tool events, user questions | Same runtime workflows, native window integration |
| Plan | Live checklist in the inspector's Activity tab | Same; the composer plan dock was removed |
| Session tools | Fork and complete replay export | Fork and complete replay export |
| Composition | Per-session drafts, IME protection, growing input, attachments | Per-session drafts, IME protection, attachments written to the selected project |
| Tasks | Activity tab: only yielded, still-running background commands; output paging, read from start/latest, stop | Same filter and actions; rows lead with the command |
| Goals | Read, set, pause/resume, clear through explicit actions | Existing goal controls aligned with explicit actions |
| Settings | Theme, shortcuts, device sign-out; automatic connection | Grouped provider/appearance settings and separate remote access |
| Remote use | Same-origin sign-in, automatic ticket renewal/reconnection | Authenticated Gateway, QR/link, device count, revocation and stop |

Worker/provider credentials remain managed on the host. Web does not expose provider-key
editing. The standalone Python Web file API still follows the Worker's startup directory;
Web explains the limit after switching workspaces. Desktop Gateway file operations follow
the selected session's workspace without changing Python.

Reliability fixes include stale socket/ticket isolation, per-session async-result guards,
failed-send draft recovery, and awaiting IPC before unwrapping runtime errors in preload.
Complete exports read replay data rather than the truncated display timeline. Gateway upload
validation accepts the full 6 MB limit without regex stack overflow. Obsolete address UI,
address persistence, superseded styles, and old Desktop background-task request paths were
removed. Electron was updated from 42.3.3 to 42.11.8, with compatible dependency fixes.

## Remote access

1. Open **Remote access** in Desktop's top toolbar.
2. Select **Local network** and click **Enable remote access**.
3. Scan the QR code using a phone on the same trusted Wi-Fi, or use **Copy sign-in link**.

The browser consumes the sign-in fragment, removes it from the address bar, and connects
automatically. Manual address/code entry is available under the collapsed connection section.
With multiple network adapters, select the address reachable by the other device there.
The loopback address works only on the desktop computer and does not show a phone QR code.

The Gateway is off by default on every app launch. Its default port is 8766. Closing the
browser leaves tasks running. **Generate new code** disconnects existing clients and revokes
unused tickets. **Turn off remote access** does not stop the local Worker; closing Desktop does
end remote access. Credentials are not written to Desktop preferences. Browser credentials
are scoped to the service address and retained in session storage/memory, not local storage.

QR codes, sign-in links, and access codes grant full agent use, including tools and workspace
files. Keep them private. Local-network mode serves HTTP and belongs on a trusted network.
For access outside it, use an existing VPN or HTTPS reverse proxy; no hosted relay, cloud
account, automatic router changes, or public tunnel is introduced.

For an existing HTTPS proxy, use **Advanced connection → Existing HTTPS address** with the
origin only, such as `https://rind.example.com`. Forward `/`, `/ticket`, and the `/ws` upgrade
to the selected local port, preserving the external Host header or using the local upstream
Host. Prefer **This computer** when the proxy runs on the same computer. A VPN connection
directly to the computer normally uses **Local network** and its VPN adapter address.

If a phone cannot connect, check the selected adapter, both devices' network, Desktop's
running state, Windows firewall access on the private network, and Wi-Fi client/AP isolation.
If the port is already used, choose a different port in Advanced connection. A missing Web
build in a source checkout is fixed with `npm --prefix desktop run build:web`.

The implementation is entirely under `desktop/`:

- HTTP/WebSocket service, one-time 60-second tickets, random access codes, Host/Origin
  checks, rate/payload/client/request limits, revocation, and deterministic shutdown.
- WebSocket ping/pong reclaims unreachable devices while preserving healthy connections.
- Per-client subscriptions do not unsubscribe the shared Desktop Worker. Remote methods
  use an explicit allowlist; Worker shutdown and credential mutation are unavailable.
- Workspace files reject path traversal and escaping symlinks. Uploads are limited to
  `uploads/`, 6 MB, and exclusive creation; existing files are not overwritten.

Reconnection restores session history and uses bounded replay reads while a turn is active.
The existing protocol has no atomic live-turn sequence watermark, so recovery is not claimed
to provide exactly-once transient events. Completed history remains the source of truth.

## Build integration

Install both dependency trees before building:

```bash
npm --prefix frontend-web ci
npm --prefix desktop ci
npm --prefix desktop run build
```

Use Node.js 22.19+ (22.x) or Node.js 24+. Desktop's prebuild creates Web assets. Prepackage
builds both surfaces, and Electron Builder includes `frontend-web/dist` in `resources/web`.
Packaging also requires a platform-specific frozen Worker in `desktop/resources/runtime`.
See `desktop/README.md` for development and packaging commands. `verify-surfaces.yml` adds
Windows/Linux Web tests, Desktop typecheck/tests, and the combined production build; it
does not alter the existing CLI release process.

## Verification

Local Windows verification on 2026-09-29, Node 22.19.0:

- Web: 269 tests passed, including connection races, automatic-address behavior, pairing,
  mobile drawers, queues, tasks, goals, and composition.
- Desktop: 127 tests passed, including runtime lifecycle, IPC error propagation, task
  cursors, full replay export, Gateway isolation/revocation, upload boundaries, and heartbeat.
- Desktop TypeScript check and Web/Desktop production builds passed.
- `npm audit` reported zero vulnerabilities in both dependency trees at verification time.
- Real Chromium: 1440×1000 and 390×844 viewports, light/dark, settings, navigation,
  drafts, tasks/goals, pairing-fragment removal, streaming, and revocation.
- Real Electron main/preload/renderer with an isolated stdio fixture: settings, task
  paging that survives refresh, LAN Gateway browser-to-Desktop messages, revocation,
  shutdown that preserves the Worker, and draft recovery after a failed send/session switch.

Browser/IAB was unavailable, so visual and interaction checks used Playwright Chromium and
Electron. Screenshots were inspected with `view_image`. No live model calls, changes to
personal settings, public deployment, or access to real sessions were used for visual QA.
The Desktop suite also runs the existing real Python JSONL lifecycle smoke test without
calling a provider. Temporary screenshots, fixture state, scripts, and processes are removed
after verification.

Visual review ledger:

| Check | Specification / observation | Result or correction |
| --- | --- | --- |
| Content hierarchy | Conversation and composer remain primary | Readable centered column; details dismissible |
| Palette | Neutral light/dark surfaces, restrained amber | Both themes inspected; transition timing accounted for in screenshots |
| Typography | Local UI/mono font stacks and consistent control sizing | Conversation, settings, task output and navigation inspected |
| Settings controls | Clear labels and ordinary controls | Removed address inputs; repaired oversized Desktop checkboxes |
| Remote access | Scan-first flow with secondary manual settings | Fixed dialog padding/scroll containment and loopback-specific guidance |
| Mobile | Single-column conversation with exclusive drawers | 390px viewport checked for overflow; full drawer inspected after animation |
| Visible copy | Product actions rather than transport configuration | No WS/token/ticket setup controls; only developer docs expose transport details |

Native Desktop project/settings controls and Web's mobile navigation are intentionally
different. There is no generated concept image or pixel-fidelity claim. Remaining validation
boundaries: no complete installer-install test, real phone hardware, public HTTPS/proxy
deployment, or local macOS/Linux execution. The new hosted CI workflow has not been run from
this local checkout.
