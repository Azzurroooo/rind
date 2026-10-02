# Rind Mobile

Android and iOS **remote clients** for Rind Desktop or an authenticated Web Worker.
The app bundles Rind's Web UI and native connection controls. No Python runtime,
model keys or local command execution are included.

## Connect

1. Keep Rind Desktop running and enable **Remote access → Local network**.
2. Choose **Scan QR code** or **Add computer**. Paste the Desktop sign-in link,
   or enter its address and access code.
3. Review the address and tap **Connect**. Camera permission is requested only
   when scanning. Manual entry works without camera access.

The desktop/worker must include this branch's mobile-origin support. Both devices
need a reachable trusted LAN, VPN, or existing HTTPS proxy. `localhost` on a phone
refers to the phone. Public HTTP is rejected; TLS errors are never bypassed.

Computer names/addresses are ordinary preferences. **Remember code** uses iOS
Keychain (without iCloud sync) or Android Keystore-backed encrypted storage. Codes
never enter WebView local/session storage. Native bridge logging is disabled,
including debug builds, to keep ticket Authorization headers out of device logs.
Disconnect preserves pairing; sign-out and forgetting remove the saved code.
Rotating the Desktop code revokes access.

Background/offline suspends the client socket, not remote work. Foreground gets a
fresh one-time ticket and restores history without resending prompts. In-memory
drafts survive reconnect, but not necessarily OS process eviction. No push service
or hosted relay is included. The remote host must stay online.

## Develop and build

Use Node 22.19+. From the repository root:

```sh
npm --prefix mobile ci
npm --prefix mobile test
npm --prefix mobile run sync
```

`mobile/src` imports `frontend-web/src` directly; do not copy its components. The
remaining commands run inside `mobile/`.

`npm run dev` previews the UI. Browsers are subject to CORS, unlike native HTTP;
use the installed app for arbitrary remote hosts. Preview never persists access
codes. Do not enable wildcard CORS for preview.

### Android

Install JDK 21 and Android SDK Platform 36 / Build Tools 36.0.0. Set `JAVA_HOME`
and `ANDROID_HOME`, then:

```sh
npm run sync
cd android
./gradlew assembleDebug
```

Use `gradlew.bat` on Windows. Output:
`android/app/build/outputs/apk/debug/app-debug.apk`. Minimum Android version: 8.0
(API 26, required by the scanner). App ID: `dev.rind.mobile`.

`npm run android` opens Android Studio. For store distribution, use `bundleRelease`
with your own signing configuration; no keys are committed. Increase
`-PrindVersionCode=N` each release. Version name comes from `agent/version.py`.

### iOS

On macOS with a Capacitor 8-compatible Xcode installation:

```sh
npm run sync
npm run ios
```

The project uses Swift Package Manager. Select your signing team and device in
Xcode. Minimum iOS: 15. Version sync reads `agent/version.py`; increase Xcode's
build number for distribution. Camera/local-network descriptions, a `rind` URL
scheme and Preferences/Filesystem privacy manifest entries are included.

`rind://connect?address=<percent-encoded-origin>#connect=<code>` opens a review
form; it never silently pairs. Desktop HTTP(S) QR codes work with the in-app
scanner. Universal links are not configured for arbitrary LAN hosts.

### Network and device boundaries

Packaged origins: `http://rind.local` (Android), `capacitor://rind.local` (iOS).
Only the WebSocket origin check admits them. Host validation, one-time tickets,
revocation and method restrictions remain enforced. Native HTTP handles `/ticket`
with 12-second timeouts and redirects disabled. No browser CORS exception is added.

Android's local HTTP origin allows LAN `ws:` without mixed-content mode. Android
cleartext/iOS ATS exceptions support LAN access; the input validator limits HTTP
to private/loopback/link-local addresses and `.local` names. Public hosts require
HTTPS/WSS. Only bundled executable assets load into the native bridge: no remote
`server.url` or unrestricted `allowNavigation`. Links open in the system browser.

Replay export uses the native share sheet and app cache. Exports older than a day
are cleaned on later exports; immediate deletion could interrupt the receiving
app. Attachments use the shared 6 MB upload path into the remote workspace.

## Verification

```sh
npm test
npm run build
npm --prefix ../desktop ci
npx playwright install chromium
npm run test:e2e
```

The smoke test uses the **real Desktop Gateway** and an isolated fake Worker. It
checks pairing, replay, six viewports (including landscape/reduced height), drawers,
files/uploads, prompt/queue/stop, reconnect/draft retention, secret isolation and
forgetting. The page uses Android's `http://rind.local` origin; only native HTTP/WS
transport is substituted. It does not prove camera, keychain, OS keyboard or
signing behavior. Temporary workspace/servers are cleaned in `finally`.

`npm run icons` regenerates native artwork from the existing Web SVG. Architecture,
reference study and validation results live in `../docs/mobile-app.md`.
