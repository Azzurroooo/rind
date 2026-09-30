# Web and desktop upgrade

Updated on 2026-09-30 on `feature/web-desktop-upgrade`. The Python Worker, CLI, and existing
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

The current specification is `surface-design-v2.md`: warm off-white/green canvases, restrained
green accents, Manrope UI text, DM Mono details, 264px navigation, and a readable
800px conversation column. Secondary details are dismissible. Mobile navigation and
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
| Information scope | Context/Activity belong to the session, Files to its workspace; Usage is a global sidebar dialog | Same hierarchy; Usage is also in the command palette |
| Settings | Theme, shortcuts, device sign-out; automatic connection | Grouped provider/appearance settings and separate remote access |
| Remote use | Same-origin sign-in, automatic ticket renewal/reconnection | Authenticated Gateway, QR/link, device count, revocation and stop |

Worker/provider credentials remain managed on the host. Web does not expose provider-key
editing. The standalone Python Web file API still follows the Worker's startup directory;
Web explains the limit after switching workspaces. Desktop Gateway file operations follow
the selected session's workspace without changing Python.

Reliability fixes include stale socket/ticket isolation, per-session async-result guards,
failed-send draft recovery, and awaiting IPC before unwrapping runtime errors in preload.
Task records now replace by ID instead of appending duplicates; in-flight polls preserve
newer events. Revalidation retains output, expansion, paging cursor, focus, and scroll position.
Polling pauses when the Activity panel/window is hidden. The old separate Web background-list
implementation was removed. Working/Waiting/Idle occupy the fixed session header, with no
extra transcript row. Desktop's Recent queue attempts each queued session once, preventing
an unpersisted draft from triggering an unbounded request loop. History dates reflect actual
conversation updates rather than opening a session, and Recent/Projects have separate headings.
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
With multiple network adapters, Rind recommends the physical Wi-Fi/Ethernet network first,
using the outbound route to break ties. VPN and virtual adapter addresses remain alternatives.
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

If a phone cannot open the page, expand **Can’t open the page?**. On Windows, **Allow Rind on
the local network** requests UAC approval and creates a rule for this executable, its active TCP
port, and `LocalSubnet`. It replaces matching Windows prompt-generated TCP blocks for that
executable (including newer GUID-named rules), and verifies remaining effective block rules.
Custom or managed rules, unrelated applications, and network profiles are not changed.
The rule persists for this executable/port; Windows Firewall's **Rind Remote Access** group
can remove it. It is updated if the repair action is run after choosing another port.
Both devices must share a reachable network; guest Wi-Fi/AP isolation and phone VPN routing
can still prevent access. No application can prove phone reachability from a local self-check.
If the port is already used, choose a different port in Advanced connection. A missing Web
build in a source checkout is fixed with `npm --prefix desktop run build:web`.

The implementation is entirely under `desktop/`:

- HTTP/WebSocket service, one-time 60-second tickets, random access codes, Host/Origin
  checks, rate/payload/client/request limits, revocation, and deterministic shutdown.
- WebSocket ping/pong reclaims unreachable devices while preserving healthy connections.
- Per-client subscriptions do not unsubscribe the shared Desktop Worker. Remote methods
  share the Desktop method policy; Worker shutdown and credential mutation are unavailable.
  Provider status and the provider-aware model catalog are supported without requiring a session ID.
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

Local Windows verification on 2026-09-30, Node 22.19.0:

- Web: 352 tests passed, including connection races, automatic-address behavior, pairing,
  mobile drawers, queues, tasks, goals, and composition.
- Desktop: 220 tests passed, including runtime lifecycle, IPC error propagation, task
  cursors, full replay export, Gateway isolation/revocation, upload boundaries, and heartbeat.
- Desktop TypeScript check and Web/Desktop production builds passed.
- Real Chromium: 1440×960 and 390×844 viewports, light/dark, settings, navigation,
  drafts, tasks/goals, pairing-fragment removal, streaming, and revocation.
- Real Electron main/preload/renderer with isolated settings and a real Python Worker:
  session history, remote pairing, Usage, and workspace files. Synthetic task events/read
  responses exercise 100 duplicate updates, preserved focus/output/scroll, and unchanged
  transcript/composer geometry across turn start/end. Web also verifies that closing the
  Inspector stops polling. No model inference is needed for these checks.
- The real-Worker smoke test now covers LAN HTTP assets, authenticated one-time ticket,
  WebSocket initialization, sessions/replay/tasks, global usage, and read-only provider status.
- Windows firewall repair was applied and its effective rules inspected. The user confirmed
  that their phone could open the login page after the matching TCP block was removed.
  Firewall regression tests cover legacy/GUID prompt rules, custom/managed blocks, unrelated
  programs and UDP, without modifying the machine's firewall during the test suite.

Browser/IAB was unavailable, so visual and interaction checks used Playwright Chromium and
Electron. Screenshots were inspected with `view_image`. No live model calls, changes to
personal settings, public deployment, or access to real sessions were used for visual QA.
The Desktop suite runs the real Python JSONL and Gateway lifecycle smoke test without
calling a provider. Temporary screenshots, fixture state, scripts, and processes are removed
after verification.

Visual review ledger:

| Check | Specification / observation | Result or correction |
| --- | --- | --- |
| Content hierarchy | Conversation and composer remain primary | Readable centered column; details dismissible |
| Palette | v2 warm off-white/green surfaces and green accent | Existing tokens preserved; light/dark inspected after transitions |
| Typography | Local UI/mono font stacks and consistent control sizing | Conversation, settings, task output and navigation inspected |
| Settings controls | Clear labels and ordinary controls | Removed address inputs; repaired oversized Desktop checkboxes |
| Remote access | Scan-first flow with secondary manual settings | Fixed dialog padding/scroll containment and loopback-specific guidance |
| Mobile | Single-column conversation with exclusive drawers | 390px viewport checked for overflow; full drawer inspected after animation |
| Visible copy | Product actions rather than transport configuration | No WS/token/ticket setup controls; only developer docs expose transport details |
| Scope | Global vs. session vs. workspace | Usage footer/dialog, three inspector tabs, explicit scope label |
| Task stability | One row per identity, no destructive output refresh | Native/React nodes, focus and scroll verified across updates |
| Working state | Header status only | Transcript and composer bounding boxes unchanged at turn start/end |

Native Desktop project/settings controls and Web's mobile navigation are intentionally
different. There is no generated concept image or pixel-fidelity claim. Remaining validation
boundaries: no complete installer-install test, full authenticated workflow on phone hardware, public HTTPS/proxy
deployment, or local macOS/Linux execution. The new hosted CI workflow has not been run from
this local checkout.
