# Desktop: Electron only bridges and owns the window

English | [简体中文](desktop.zh-CN.md)

Desktop's Electron main process starts and holds a module-level Worker runtime. Preload exposes a narrow interface through an allowlist, and the renderer only calls those interfaces and subscribes to snapshots and events. The current implementation is not "one permanent Worker per workspace": `startRuntime` reuses an existing runtime when it is still alive, and the workspace is passed in as a launch argument and request context.

~~~mermaid
flowchart LR
    R["Renderer<br/>native DOM/TS"] -->|allowlist| P["Preload contextBridge"]
    P --> M["Electron main"]
    M --> W["Python app-server --stdio<br/>single live runtime"]
    M --> G["Remote Gateway (optional)"]
    G --> B["remote Web / Mobile"]
    G --> M
~~~

The main process maintains request_id values and pending promises; `runtimeGeneration` discards late replies from an old process; stderr is captured with a bound; and `shutdownPromise` waits for exit. Worker errors are returned in an envelope, which preload unpacks into Errors carrying `type`, preserving the renderer's try/catch semantics.

preload also exposes capabilities such as runtime, auth, settings, models, sessions, workspaceFiles, background, goal, and notifications; the renderer cannot touch Node or Python directly. The remote Gateway reuses the local Worker and manages tickets, Origin/network policy, and Web static assets itself. Turning off remote access clears remote tickets but leaves the local Worker running.

## Build and remote access

Once the Python environment is configured, use Node.js 22.19+ (22.x) or 24+ and run the following in the repository root:

~~~sh
npm --prefix frontend-web ci
npm --prefix desktop ci
npm --prefix desktop run build:web
npm --prefix desktop run dev
~~~

`build` builds Web first. `package` also requires a frozen Worker in desktop/resources/runtime, which is copied to the application's resources/runtime at package time, and the Web artifacts are copied to resources/web. These commands build the local application; they do not publish a release.

Enable sharing in Desktop's Remote access, then scan the code from the same trusted network or use the sign-in link. Remote access is off by default at every startup, and Generate new code revokes existing connections and unused tickets. External network access relies on an existing VPN or an HTTPS reverse proxy; Desktop does not create a public tunnel. Closing the browser disconnects only that client; only closing Desktop ends the remote entry it hosts.

Source: [runtime management](../../../desktop/src/main/runtime.ts), [main IPC](../../../desktop/src/main/index.ts), [preload allowlist](../../../desktop/src/preload/index.ts), [remote Gateway](../../../desktop/src/main/gateway/server.ts), [build scripts](../../../desktop/package.json). Verification: [runtime lifecycle](../../../desktop/scripts/runtime-lifecycle.test.mjs), [preload](../../../desktop/scripts/preload-runtime.test.mjs), [Gateway](../../../desktop/scripts/gateway.test.mjs).

[Back to the series map](../README.md)
