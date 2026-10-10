# Web and Mobile: sharing a Surface, swapping platform capabilities

English | [简体中文](web-and-mobile.zh-CN.md)

The Web Surface uses React/Vite and a reconnectable WebSocket runtime client. Mobile reuses the same React components, injecting Capacitor capabilities through `SurfacePlatform`: secure storage, code scanning, system lifecycle, native HTTP, and sharing.

~~~mermaid
flowchart LR
    UI["Shared React Surface"] --> P["SurfacePlatform"]
    P --> B["Browser: fetch + sessionStorage"]
    P --> N["Mobile: Capacitor secure storage / native HTTP"]
    B & N --> T["ticket / credential provider"]
    T --> WS["WebSocket runtime client"]
    WS --> W["Worker app-server --web or Desktop Gateway"]
~~~

The client assigns a request_id to each request and distinguishes events from responses. Once the connection is established it pings every 10 seconds and closes if no sign of life appears within 25 seconds. Reconnection after a disconnect uses backoff starting at 500ms and capped at 8 seconds, and unfinished requests are rejected; a 401/403 or a 4401 moves the client to unauthorized, with no blind retries. Long requests (prompt, compact, command) default to 15 minutes, and ordinary requests to 30 seconds.

On the Web the ticket is stored in sessionStorage; on mobile, the native ticketFetch forbids redirects, requires HTTPS (except for local pairing addresses), and uses a bounded timeout. A Desktop Gateway one-time ticket is valid for 60 seconds, and both the WebSocket connection count and the subscription count are capped. Origin is only a source check; a ticket must still be consumed.

Mobile does not run Python, models, or shell; it is a remote Surface. The Worker address configured in the frontend must be an explicit ws/wss URL with no username, password, query, or hash, so that an old link cannot be treated as an implicit redirect.

## Two remote entry points

Desktop remote access reuses its live Worker directly; a standalone deployment runs Python app-server --web, and the service stays alive after the browser is closed. After the connection is restored the upper layer re-initializes, resubscribes, and restores the view together with the historical cursor; the client does not automatically resend every failed request, to avoid duplicate side effects. See [replay](../01-runtime/replay-and-resubscribe.md).

A standalone Docker deployment sets, in .env at the repository root:

~~~dotenv
RIND_SERVER_TOKEN=replace-with-a-long-random-token
RIND_WORKSPACE=/absolute/path/to/project
RIND_HOME=/absolute/path/to/rind-data
~~~

Place the provider settings.json in the chosen data directory, then run `docker compose up -d --build` and visit http://localhost:8080. Compose makes RIND_SERVER_TOKEN mandatory, and the default browser entry binds only to 127.0.0.1. RIND_WEB_PORT and RIND_WEB_BIND can change the entry; public use requires a matching TLS proxy.

For Mobile's development build and native platform prerequisites, see [mobile/README](../../../mobile/README.md); for Web's local Vite proxy, see [frontend-web/README](../../../frontend-web/README.md#local-development). Device acceptance and simulated browser regression are separated by the [verification article](../08-engineering/verification.md): a pass on Web does not imply that code scanning, the keyboard, or system sharing has also passed.

Source: [Web runtime client](../../../frontend-web/src/runtimeClient.js), [platform injection](../../../frontend-web/src/platform.jsx), [ticket](../../../frontend-web/src/ticket.js), [Mobile native bridge](../../../mobile/src/native.js), [Mobile app](../../../mobile/src/MobileApp.jsx), [Compose](../../../docker-compose.yml). Verification: [Web client](../../../frontend-web/src/runtimeClient.test.js), [Mobile ticket](../../../mobile/src/native.test.js), [Mobile pairing](../../../mobile/src/MobileApp.test.jsx).

[Back to the series map](../README.md)
