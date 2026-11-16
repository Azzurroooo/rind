# Messaging gateway: folding chat channels into session events

English | [简体中文](gateway.zh-CN.md)

The Gateway adapts channels such as Discord, Telegram, and Slack into a unified InboundMessage, then routes it to a Worker through a persistent session key. It owns security admission, deduplication, and the event cursor; tool details are never sent to the chat channel directly.

~~~mermaid
flowchart TB
    C["channel adapters"] --> P["pump"]
    P --> D["message_ref deduplication"]
    D --> S["SecurityGate<br/>allowlist / pairing / group mention / cooldown"]
    S --> R["SessionRouter<br/>channel:type:chat[:thread]"]
    R --> W["Worker request + events"]
    W --> E["durable conversation events"]
    E --> O["channel outbound / reaction"]
    R --> F["state.json: session_id + cursor"]
~~~

The same channel, chat_type, chat_id, and optional thread_id always yield the same key. The first routing call invokes session/new and retries only once on failure. The cursor advances only with durable conversation events, so task_updated/task_output snapshots do not crowd out chat history. state.json is written atomically, and a corrupt file is renamed to `.corrupt` before the gateway starts from an empty mapping.

The inbound order is message_ref LRU deduplication, the admission decision, slash control commands, numeric replies to pending questions, follow_up for a busy turn, and finally a new prompt. A DM is allowed by the allowlist or by pairing; a group chat requires the group to be in group_allow and the text to @-mention the bot. Pairing codes are six unambiguous characters and have a pending cap, and allowed senders are also bound by a cooldown window.

The event pump maintains the conversation cursor and reactions: a valid numeric option is used first to answer a pending question, and other text still follows the ordinary input route. While the Worker is offline, up to 100 inbound messages are buffered, the oldest entry is dropped once the limit is exceeded, and they are processed in order after recovery. Channel SDKs are imported lazily per enabled entry; when the stdio transport closes, stdin is closed first and stdout is drained, waiting at most 30 seconds; closing a WebSocket only ends the connection.

## Configuration entry points

When starting from source, run the Worker in one terminal and the wizard and gateway in another:

~~~sh
node runtime/dist/cli.js app-server --web --host 127.0.0.1 --port 8765 --cwd /absolute/path/to/project
~~~

~~~sh
node frontend-cli/bin/rind.js gateway init --workspace /absolute/path/to/project
node frontend-cli/bin/rind.js gateway --config /absolute/path/to/project/.rind/gateway.yaml
~~~

The wizard writes .rind/gateway.yaml into the chosen workspace; channel SDKs, platform accounts, and callback requirements are decided by the corresponding adapter. If the Worker enables authentication, a connection token must also be configured. `rind gateway doctor` checks configuration and dependencies, and `rind gateway approve <CODE>` approves a pairing; both should use the same configuration and workspace as the running instance.

The `runtime/src/gateway/` module described here is the messaging channel command (`rind gateway`), and it is different from Desktop's internal HTTP/WebSocket Gateway. The former turns chat messages into session input, while the latter exposes the same graphical Surface to remote devices.

Source: [routing](../../../runtime/src/gateway/router.ts), [pump](../../../runtime/src/gateway/pump.ts), [security gate](../../../runtime/src/gateway/security.ts), [transports](../../../runtime/src/gateway/transports.ts). Verification: [routing](../../../runtime/src/gateway/router.ts), [security](../../../runtime/src/gateway/security.ts), [pump](../../../runtime/src/gateway/fake-worker.ts), [stdio shutdown](../../../runtime/src/gateway/transports.ts).

[Back to the series map](../README.md)
