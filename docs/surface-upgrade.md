# Web and desktop upgrade

Updated on 2026-09-30 on `feature/web-desktop-upgrade`. Both surfaces continue to use
runtime protocol v2. The CLI and existing messaging gateway are unchanged. The current
compaction fix makes two small Worker changes: explicit compaction bypasses the stopped-turn
continuation block without clearing it, and live snapshots retain the operation kind.

## Design and reference study

Local references:

- Jan (`E:/code/agent1/ui-open-source/jan`): `web-app/src/containers/ThreadList.tsx`,
  `SettingsMenu.tsx`, `ChatInput.tsx`. Applied quiet project navigation, explicit settings,
  composition-safe input, and contextual session actions.
- LobeHub (`E:/code/agent1/ui-open-source/lobehub`): `DESIGN.md` and
  `src/routes/(main)/group/_layout/Sidebar/Topic/TopicListContent/ByTimeMode/GroupItem.tsx`.
  Applied neutral semantic surfaces, a 4px spacing rhythm, content-first hierarchy, and
  compact session rows. The September 30 interaction revision removes date groups.
- This revision also studied Jan's `web-app/src/components/ui/popover.tsx` and LobeHub's
  `src/features/Conversation/ChatInput/index.tsx`: stable composition while a run is active,
  per-conversation queues, and popovers that stay inside the available viewport.
- These are design and interaction references, not imported implementations or dependencies.
- The composer refinement also reviewed LobeHub's `ChatInput/SendArea/SendButton.tsx`,
  `Conversation/ChatInput/utils.ts`, `ModelSelect/ReasoningEffortSelect.tsx`, and
  `ClarificationQuestions/index.tsx`: persistent run feedback, secondary send actions,
  grouped choices, and keeping question drafts until acknowledged. Rind uses a single
  primary control plus a click/touch menu to meet the requested lower button count.

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
| Navigation | Project selector, chronological history, search, mobile drawers | Native project folders, session search, recent/project navigation |
| Conversation | Streaming, queue/steering, stop, tool events, user questions | Same runtime workflows, native window integration |
| Plan | Live checklist in the inspector's Activity tab | Same; the composer plan dock was removed |
| Session tools | Fork and complete replay export | Fork and complete replay export |
| Composition | Per-session drafts, IME protection, growing input, attachments, unified send/effort controls | Same controls; attachments written to the selected project |
| Compaction | Session-scoped progress, cancellation, reconnect recovery | Same; long requests also cover slash commands and Gateway forwarding |
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

### September 30: live inputs, recent sessions, and remote composition

This follow-up fixes the five reported interaction issues without changing Python sources:

- Desktop's preparation lock now ends when a prompt is dispatched, rather than when its
  full streaming RPC returns. Web waits for the starting turn's ID before routing another
  input. Queue remains available during a run; both surfaces expose a clickable Steer action.
  A turn settling during a Web queue request falls back to a normal prompt in the original
  session. Drafts survive failures. Queue delivery is reconciled by input ID, including an
  event arriving before the corresponding response and another client's queued input.
- Desktop's runtime bridge attaches the accepted prompt and client input ID to the existing
  `turn_started` event, preserving its sequence. Both viewers reconcile the originating
  optimistic message instead of duplicating it. Remote delivered inputs render even when
  they were not present in the viewer's local queue. Gateway and bridge code stay in `desktop/`.
- Projects precede Recent with a dividing rule. Date grouping code/styles/tests were removed.
  Initial lists contain 10 rows; Load more is explicit. Desktop uses store pagination and
  retains the user's expanded list across advisory refreshes. Recent ordering uses the newest
  visit or conversation update; Web's visit metadata is scoped to the connected host/tab.
- New session uses the confirmed project on the Rind computer. A fresh browser initially
  uses the worker's reported folder; a restored session uses its own workspace. The full path
  is visible in the project selector. Unsubmitted/cancelled path edits cannot change it.
  Each Gateway browser connection also keeps its own fallback workspace.
- Mobile attachment and command controls no longer wrap. The model panel is anchored to
  the input frame on small screens, and grid tracks may shrink below content width. Long
  model/provider names truncate within the panel; the available models remain selectable.

Verification for this revision:

- Web: **356 tests passed**. Desktop: **220 tests passed**. Desktop typecheck and both
  production builds passed; focused picker/sidebar tests passed after the final visual edits.
- An isolated Electron main/preload/renderer, the **real Python Worker**, the actual Desktop
  HTTP/ticket/WebSocket Gateway, and a Playwright mobile browser exercised the complete flow.
  A local streaming chat-completions fixture controlled six model steps without calling an
  external model. Desktop queue, direct steer, promote and recall reached the worker. Remote
  prompt, steering and follow-up each appeared exactly once in both transcripts.
- In-flight and idle composers were inspected at 320/390px, with additional 768/1280px checks.
  Model-menu bounds, toolbar alignment, long names and horizontal overflow were measured.
  An initial active-state grid overflow at 320px was found and corrected; repeat QA passed.
- Screenshots were inspected against the existing v2 tokens: project/recent hierarchy,
  unchanged cream/green palette, typography, single-row controls, panel edges and long-name
  truncation. New visible copy is limited to folder location, pagination and Steer controls.
  Browser/IAB had no enabled browser, so Playwright Chromium/Electron supplied the captures.
- One parallel test run timed out during real-worker initialization. An isolated rerun and
  the subsequent full Desktop suite passed. No worker implementation changes were made.

Steering is applied at the worker's next model/tool checkpoint; it does not abort an in-flight
model request. Hardware-phone keyboard/rotation behavior and packaged-installer execution
remain outside this desktop automation pass. Temporary fixtures and screenshots are removed
after review; no personal settings or real conversations are used.

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

## Composer refinement and compact verification (2026-09-30)

This is the current revision, following the baseline verification above.

- One primary send/stop control and a secondary Message actions menu replace the separate
  Stop / Steer / Queue button row. Enter still queues and Alt+Enter still steers. Stop is
  accessible with an unsent draft, without discarding it. Menu slots never change width.
- Model and effort chips share icons, labels, checked rows, provider grouping, filter behavior
  and keyboard navigation. Desktop no longer uses the old mono effort list. The 320px Web
  toolbar reserves two rows so model and effort remain readable.
- The permanent composer context row shows the actual workspace and a three-dot running
  indicator before the first token. Web's folder hint opens a full host path. No status row
  is inserted or removed when a turn starts or finishes; reduced-motion is supported.
- Desktop questions use neutral radio rows and a custom textarea. Controls remain mounted
  across stream updates. Confirmation is acknowledged before removal; failures retain the
  draft and allow retry. A question answered on one surface is reflected on the other.
- Compact now uses the 15-minute long-request policy through Desktop and its Gateway,
  including slash-command RPCs. The Desktop `/compact` action shares the direct path.
  Progress is session-scoped, duplicate submissions are guarded, drafts remain editable,
  and terminal events restore the normal controls. Durable events own success feedback;
  redundant replay refreshes and success banners were removed.
- A regression reproduced `Compaction did not complete` after Stop. The Worker change allows
  explicit compact despite the automatic-continuation suppression marker, leaving that
  marker intact. Live snapshots also carry `operation`, so reconnecting during compaction
  restores the correct state. Model, summarization and tool execution algorithms are unchanged.

Final local checks:

| Check | Result |
| --- | --- |
| Web unit/integration suite | 363 passed |
| Desktop suite, including real Worker/Gateway smoke | 224 passed |
| Python compact, Worker and continuation regressions | 60 passed |
| Desktop TypeScript check | Passed |
| Web and Desktop production builds | Passed |
| Electron → real Python Worker → Desktop Gateway → Chromium | Passed with an isolated local model fixture |

The end-to-end run exercised remote queue and steer during a pending prompt, live local
transcript updates, Stop with a preserved draft, manual compact after Stop, a **32-second**
non-streaming summary crossing the old timeout, browser reload while compacting, Desktop
`/compact`, a custom question answer, and reduced-motion. Both clients recovered to Ready,
and the browser observed the Desktop-submitted answer. No page errors were recorded.
Separate regression tests cover compaction cancellation/failure and session-switch isolation.

Visual verification used the existing `docs/surface-design-v2.md` specification, not a new
concept image. Browser/IAB reported no enabled browser, so Playwright drove the real Electron
renderer and Chromium. Captures were inspected after finite menu/drawer animations settled.
Web widths 320, 390, 768 and 1280px were measured; the native Windows Desktop viewport was
also inspected. The idle/running composer bounds stayed stable while waiting for the first token.

| Visual check | Evidence and correction |
| --- | --- |
| Palette and container hierarchy | Existing warm background, green accent, open conversation and restrained composer preserved |
| Model/effort typography | Matching chips and checked rows; removed leftover Desktop mono effort styling |
| Phone toolbar | Fixed rows at 320px keep the model readable; attachment and command icons remain aligned |
| Popover boundaries | Model and send menus remain inside the composer/viewport at all four tested widths |
| Question card | Neutral radio rows, clear question/description hierarchy, visible custom answer and submit state |
| Workspace discoverability | Folder label visible with navigation closed; tap opens the full host path |
| Motion | Permanent status slot; animated dots do not participate in layout; static in reduced-motion mode |
| Copy and feedback | Intentional changes limited to working-folder/status labels, send menu, effort labels and question form; duplicate compact banner removed |

The implementation was verified against the existing design specification with no outstanding
material visual mismatches in the inspected states. Native project selection and Web's
mobile folder popup remain intentional surface differences. A notification icon also replaces
the overflowing long footer label, retaining its accessible name and tooltip.

Verification used isolated settings, sessions and a local model fixture. No personal credentials
or conversations were used. Temporary captures, scripts, dependencies, data and processes are
cleaned after inspection. This pass does not claim a new hardware-phone or installer test.
Packaging this revision must include the small Worker fix together with the rebuilt surfaces.

## New-session and inspection fixes — September 30, 2026

This pass changes only `frontend-web/`, `desktop/` and surface documentation. It adds no
Python Worker changes or production dependencies.

- **New-session model and effort:** Desktop reads the provider-aware runtime catalog
  before a session exists. Web omits an absent session ID instead of sending an invalid
  empty ID. Both surfaces allow draft selections and apply provider, model and effort
  before the first prompt. Catalog refreshes preserve draft choices; configuration
  failures restore the message instead of sending with a different model. The composer
  no longer writes a chosen model to global settings.
- **Working-folder control:** the full path label lives inside a padded, width-bounded
  hover target. Long paths truncate within the target rather than extending beyond it.
- **Task noise:** background lifecycle snapshots no longer generate transcript cards.
  Removed the obsolete replay-to-transcript task restoration path. Activity and actual
  tool output remain available.
- **Mobile Files:** a bounded directory region and a larger preview region scroll
  independently, with a fixed filename/close header between them. Selected rows are
  highlighted; stale reads cannot replace another file or reopen a closed preview.
- **Cache usage:** both global Usage views show cache-read tokens and the weighted
  period hit rate, `cached / input`. Input already includes cache reads. Missing fields,
  invalid counters and an empty denominator do not produce fabricated percentages.
- **Tool folds:** stable single-to-multiple-call shells, a 600ms completion grace period
  and 220ms grid-height/opacity transitions. Explicit user choices and focused tool rows
  stay open. Desktop reconciles keyed tool nodes instead of rebuilding their subtrees;
  live tool details no longer flash open and shut automatically. Collapsed regions are
  inert, and reduced-motion is respected.

Reference implementations inspected locally:

- Jan `web-app/src/components/ui/collapsible.tsx` and the existing provider-grouped
  composer pattern.
- LobeHub `src/features/Conversation/Messages/AssistantGroup/components/WorkflowCollapse.tsx`:
  distinct streaming/completion phases, user expansion priority, and avoiding duplicate
  completion folds.
- LobeHub `src/features/Conversation/WorkingSidebar/Files/index.tsx`: a bounded scrollable
  tree with fixed surrounding controls.
- LobeHub `src/features/Conversation/Messages/components/Extras/Usage/UsageDetail/tokens.ts`:
  cache reads separated from other input categories; Rind uses its own ledger semantics.

Validation:

| Check | Result |
| --- | --- |
| Web unit/integration suite | 372 passed |
| Desktop suite, including real Worker/Gateway smoke | 227 passed |
| Desktop TypeScript check | Passed |
| Web and Desktop production builds | Passed |
| Isolated Electron → Python Worker → Desktop Gateway → Chromium | Passed |

The live run selected a different provider/model/effort in a new Desktop session and
verified the created session metadata. A second first-message flow applied the chosen
effort, executed three real Bash commands and read a file through a local model fixture.
The remote browser replayed the same session without Task metadata cards. Both Usage
views displayed 900 cache-read tokens out of 1,200 input tokens, or 75.0%; saved defaults
remained unchanged.

Rendered captures were inspected at Web widths 320, 390 and 1280px and in the native
Windows Electron window. The 66-file directory scrolled independently of its preview;
preview content remained immediately visible. Mobile model menus stayed within the
viewport. Both tool folds showed intermediate heights during opening and closing while
retaining the same shell node. Reduced-motion and absence of page errors were checked.
Unit regressions also cover same-model/different-provider selection, a late catalog reply,
selection-application failure, out-of-order file reads, missing cache data and fold focus.

Validation used isolated settings, credentials, sessions and workspace files. Temporary
test processes and artifacts were removed after inspection. This is a source/build
verification; it does not claim a new installer or a hardware-phone test.

## Command and transcript refinement — 2026-09-30

The current design contract is `docs/surface-design-v2.md`, sections 4–6.
This is a focused refinement within the existing design system, so no new bitmap
concept or visual assets were introduced. References inspected: Jan's
`web-app/src/containers/MessageItem.tsx` (shared user/assistant timestamp and action
row) and LobeHub's `Conversation/Messages/AssistantGroup/components/WorkflowCollapse.tsx`
(secondary tool workflow, stable folding and manual expansion).

Changes:

- Removed GUI-only slash forms for config, context, doctor, login, logout, model,
  effort, session/sessions and theme. The filtered catalog governs menus, help and
  execution; removed aliases and unregistered input cannot fall through to the
  Worker. Existing settings, model/effort pickers and palette actions remain.
- Both status views consume the CLI's actual `entries/usage` contract, including
  settings state, API-key presence, endpoint, model/effort, context usage/capacity,
  input/output, cached input and cache-hit rate. No completed sample is distinct
  from a real sample with zero cache hits. Late Web results cannot enter a different
  session after navigation.
- Tool work has one muted surface, a fine border, smaller text and a subdued
  completion icon, aligned with the prose column. Existing stable shells, delayed
  automatic folding, manual expansion and reduced-motion support remain.
- Message actions include a local clock and a full date/time/timezone tooltip.
  Hover changes opacity only; touch keeps the actions/time visible. Replay and
  remote events use actual recorded time. Missing legacy time is not invented.
- Desktop now finalizes an existing prose entry when tool events precede its
  completion event, avoiding duplicate text. New post-tool prose remains a
  separate chronological message even if an older runtime omits completion.

The only Python change retains the already-persisted `ts` alongside an opt-in
message ID in UI projections. Default model-facing projections, the turn runner,
tool execution and Worker lifecycle are unchanged. A regression asserts timestamp
identity and that model payloads receive no UI metadata.

Verification:

| Check | Result |
| --- | --- |
| Web unit/integration suite | 380 passed |
| Desktop suite, including real Worker/Gateway smoke | 232 passed |
| Selected persistence, protocol, command, fork and projection tests | 174 passed |
| Desktop TypeScript and both production builds | Passed |
| Isolated Electron → real Python Worker → Gateway → Chromium | Passed |

Web's parallel test workers caused the Desktop smoke's 15-second initialization
budget to expire when both full suites ran together. The complete Desktop suite
passed in isolation; the production startup timeout was not changed to mask it.

The live fixture streamed prose, executed three real file reads and returned
12,000 input tokens with 9,000 cached tokens. Both status views rendered 75.0%
cache hits. The remote replay and reload preserved all three prose timestamps.
Removed commands were absent from menus; manually entering a removed Desktop
command produced the local unavailable notice. Hovering a user message left its
bounding rectangle unchanged. A fresh touch browser authenticated with the
desktop code, opened the session and displayed message times without hover.

Browser/IAB reported no enabled surfaces, so Playwright controlled the real
Windows Electron window and local Chromium. Captures at 1280×900, 390×844 and
320×844, plus native Electron resolution, were read back with `view_image`.
Light/dark, collapsed/expanded tools, status and slash-menu states were inspected.

| Visual comparison against the design contract | Outcome |
| --- | --- |
| Shared reading-column alignment | Fixed a tool margin override; prose, tools and composer now align |
| Main prose versus secondary tool typography | 15px prose stays prominent; 12px summaries and muted details recede |
| Palette, icons and boundaries | Existing tokens and Lucide icons retained in both themes |
| Hover/focus/touch metadata | Reserved action row; readable timestamp and full-date tooltip |
| Status hierarchy and long values | Configuration separated from latest sampling; long paths wrap on phones |
| Responsive width and menus | No document overflow at 320/390px; slash menu remains within the viewport |
| Fold interaction | Manual expansion and subsequent collapse work without replacing the group |

First-viewport copy was checked against the requested changes: additions are limited
to message time, the unavailable-time fallback, status labels and unavailable-command
guidance. No unrelated navigation or marketing copy was added. No remaining visual
mismatch was found in these inspected states. The timestamp projection is the
documented scope exception. Temporary QA settings, sessions, model fixture, processes
and screenshots were removed after inspection. This verification does not represent
a newly packaged installer or a physical-phone test.

## Sidebar pagination and title visibility — 2026-09-30

This focused correction follows `docs/surface-design-v2.md`, section 3. References
inspected: Jan's `web-app/src/containers/ThreadList.tsx` and
`components/ui/sidebar.tsx` (reserved menu space and truncated titles), plus
LobeHub's `src/features/NavPanel/components/NavItem.tsx` (hover/focus actions).
Jan's reserved-space approach fits this sidebar; the old title-width gradient
could erase one- and two-character titles entirely.

- Both surfaces use a transparent, full-width Load more row with left-aligned
  13px text, 32px height and a trailing chevron. Loading replaces the chevron with
  a spinner, retains the same bounds, exposes busy state and disables the button.
  Desktop project pagination shares the same styling.
- Desktop reserves menu space at rest and uses ellipsis for long titles. Hover
  changes only the menu opacity. Web keeps its separate action slot and reveals
  it when the row receives keyboard focus.
- Browser inspection exposed a second cause of missing titles: Web's implicit
  grid column could grow to fit a long title, then scroll horizontally when an
  offscreen action received focus. A shrinkable grid track and row minimum width
  keep titles, actions and pagination inside the sidebar.
- Removed the obsolete mask, old pagination selectors and stale fade-mask comment.
  The design contract now documents stable title bounds and current row sizes.
  Python Worker and gateway implementation were not changed.

Verification: 10 Web sidebar tests and 10 Desktop sidebar/session tests passed;
Desktop TypeScript and both production builds passed. Browser/IAB had no enabled
surfaces, so Playwright exercised the built Electron app and Chromium through the
real local Desktop gateway with isolated session data. The 35 recorded checks
covered project/recent rows, selected rows, one/two-character Chinese and English
titles, long titles, 232/264px Desktop sidebars and 1280/390/320px Web viewports.
Hover/focus preserved title bounds, menu buttons stayed within the sidebar, and
the Web list had no horizontal overflow. Pagination loaded 10 → 12 sessions and
removed its control at the end. Delaying the Web pagination request also verified
fixed loading bounds, busy/disabled state and one request despite a repeated click.

Screenshots of light/dark, narrow, menu-open and loading states were read back
with `view_image` against the existing design contract; no new bitmap concept was
needed for this local fix. Checked text alignment, font size, neutral fills,
chevron/spinner sizing, title truncation, menu boundaries and mobile fit. No
navigation or visible copy was added or renamed, and no mismatch remained in the
inspected states. Temporary QA profiles, sessions, scripts and screenshots were
removed and their processes closed. This was not an installer or physical-phone
test.
