# Android device acceptance

Verified on **2026-10-02–03, Asia/Shanghai**, on branch `feature/mobile-app`.
The final debug APK is installed on the tested phone. Build metadata and its
SHA-256 are recorded in [mobile-app.md](mobile-app.md).

## Environment and execution boundary

- Physical device: `2206122SC` (`unicorn`), Android 14 / API 34.
- Display used: 1080×2400, density 420; portrait WebView approximately 411×867
  CSS px and landscape 883×364 CSS px.
- WebView: Chromium `150.0.7871.181`.
- Device connection: paired wireless ADB on a trusted local network.
- Application path: native Capacitor HTTP ticket request and native WebView
  WebSocket → actual Desktop Gateway → actual Python Worker on Windows.
- Model: local `FakeOpenAIServer`, with an isolated workspace and `RIND_HOME`.
  No paid model or user's project files were used for remote tool execution.

The device run is separate from the production browser smoke, which substitutes
native transport and uses an isolated fake Worker bridge. Only the model provider
was substituted in the physical-device workflow.

## Fixes found on the device

1. **Android Back dismissed the conversation while a model menu was open.**
   Include listboxes in overlay dismissal and route Escape to the owning input
   for slash-command suggestions. The current conversation and draft stay open.
2. **Dark mode left a white status-bar background under light icons.**
   Register the small Android `RindAppearance` plugin and apply the shared `--bg`
   color after SystemBars updates icon contrast. Reapply the saved background
   after resume and configuration changes, including rotation.
3. **Cancelling the Android share chooser showed an export failure.**
   Treat the plugin's explicit `Share canceled` result as cancellation; retain
   errors for actual sharing failures.

Also remove the redundant `Keyboard.resizeOnFullScreen` option so SystemBars
owns Android keyboard insets. The existing `resize: body` setting remains.
Four new unit/UI tests cover Back routing, theme update ordering and both sharing
cancellation and real failure behavior.

## Real Desktop connection follow-up

After the isolated QA run, scanning the running Desktop's QR succeeded but Connect
reported that the host was unreachable. The computer could reach its own LAN
ticket endpoint; the phone's native HTTP connection timed out. Windows classified
the active Wi-Fi as Public, and the Gateway was listening on `0.0.0.0`.

Applying the existing Desktop local-network firewall action resolved the timeout.
Its rule is scoped to the current executable, TCP gateway port and `LocalSubnet`;
the firewall and the network profile remain enabled/unchanged. An unauthenticated
phone probe then received the expected HTTP 401, establishing reachability.

The scanned code subsequently authenticated to the user's running Desktop. Actual
`initialize`, session list/switch/replay/subscribe, file list, context inspection,
model list and provider list requests completed without RPC or page errors.
No prompt or paid model request was submitted. This real computer connection and
its remembered credential were left available in the app.

## Device results

| Area | Verified behavior |
| --- | --- |
| Packaging | Install, cold launch, native plugin registration; installed `base.apk` hash equals the locally built APK |
| Authentication | Incorrect code rejected; correct code connects over LAN; code rotation revokes an active connection and removes the saved old code |
| User's Desktop | Scanned code authenticates after the scoped Windows firewall repair; initialization, session listing and replay complete |
| Pairing | Camera decodes a Desktop QR into the confirmation form; native deep link also requires explicit Connect; cancelling the scanner preserves the form |
| Credentials | Remembered code survives app process restart/reinstallation; opting out requires re-entry; no plaintext access code found in WebView local/session storage, Android preference files or current app logs |
| Conversation | Chinese input, streamed responses, history restoration and remote model selection |
| Computer tools | `read_file` runs in the isolated computer workspace; Bash creates a file there and its contents are checked on Windows |
| Attachments | Android system file picker selects a phone Download fixture; the remote workspace receives identical bytes |
| Active work | Queue, withdraw queued input, promote input to steering, and stop an active turn |
| Keyboard and Back | Composer remains visible with the real IME; Back hides the keyboard or dismisses sidebar, inspector, settings, model list and command suggestions before navigation |
| Appearance | Light/dark theme and matching system bars; real landscape rotation with composer inside the viewport |
| Lifecycle | Background closes the client socket; remote work finishes on the computer; foreground replays the result without cancellation or duplicate prompt submission |
| Reconnection | Dropped socket reconnects; draft and history survive; prompts are not resent |
| Sharing | Actual Markdown file content and Android share chooser; cancellation produces no export error |
| Session cleanup | Sign-out removes the saved code; cancelling Forget preserves the entry; confirming Forget removes only the QA computer |

The camera check decoded the user's running Desktop QR, rather than the separate
QA Gateway QR. Its host and nonempty access code were verified in the review
form, without automatically connecting. The follow-up above verified explicit
connection to that Desktop. Tool execution tests used only the QA Gateway and
scripted model; the user's Desktop model was not exercised.

## Automated checks and cleanup

- Mobile unit/UI tests: **34 passed in 4 files**.
- Production browser Gateway smoke: passed, including six viewport sizes,
  authentication, attachments, queued work, reconnect and credential isolation.
- Android `assembleDebug`: passed with JDK 21, Gradle 8.14.3 and SDK 36.
- APK metadata and v2 signature verification: passed. All **29** bundled Web
  resources match the final `mobile/dist`; native bridge logging is disabled.
- Final app-specific log review: no Java/native crash, ANR or leaked QA access
  code found in the captured current-process logs.
- The QA saved computer, test exports and phone file fixtures were removed;
  original rotation settings were restored. The isolated Gateway, Worker and
  model fixture were stopped, and temporary ADB forwards removed.
  The final app installation, wireless ADB pairing and user's real Desktop
  connection remain available.
- Local scratch directories remain excluded from Git. Recursive cleanup of
  `mobile/.qa` and the three isolated temporary workspaces was rejected by the
  execution approval check (`blocked by policy`); these artifacts were retained.

## Limits

This acceptance covers one Android device and OS version. iOS was synchronized
and its project metadata reviewed, but was not compiled, signed or device-tested
on Windows. No store release signing, paid-provider acceptance, push delivery or
long-duration background endurance was tested. Sharing stopped at the chooser
and cancellation; no message or file was sent to a receiving application.
