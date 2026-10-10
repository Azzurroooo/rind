# Trust boundaries: each layer only guarantees what it checked itself

English | [简体中文](trust-boundaries.zh-CN.md)

Rind can access host files and processes. Protocol authentication, file path constraints, and external content labeling solve different problems; together they do not form an operating-system sandbox.

~~~mermaid
flowchart TD
    U["Remote user"] --> A["Connection authentication<br/>server token / one-time ticket"]
    A --> W["Worker protocol methods"]
    W --> F["File tools<br/>path resolution / Capsule allowed roots"]
    W --> S["Shell<br/>host process permissions"]
    X["Web pages and process output"] --> N["Tool results / untrusted content labeling"]
    N --> M["Model context"]
    M --> W
~~~

## Three boundaries to keep distinct

| Boundary | What is actually checked | Guarantees that must not be inferred |
| --- | --- | --- |
| Remote connection | Without a token, the Python Web server allows only loopback binding; once a token is configured, authentication is verified and one-time tickets are supported | Once connected, each shell command still requests operating-system permissions on its own |
| Files and Capsule | Resolve paths and check the applicable allowed roots; Team file tools are confined to their own Capsule and permitted regions such as shared | The Shell, external editors, and other Workers obey the same directory isolation |
| Content entering the model | Task notifications separate trusted task facts from untrusted_process_output, and tool results keep their source | Text labeling can mechanically prevent all prompt injection |

The Python Web server supports authentication paths such as Bearer and token/ticket, with an Origin check constraining browser origins; the Desktop Gateway maintains its own access code, tickets, and origin rules. The two entry points share the runtime protocol but must not be described as the same authentication implementation. The [messaging channel Gateway](../07-surfaces/gateway.md) additionally has allowlist, pairing, and group-mention gating.

The file rewrite queue coordinates only the current Worker's managed writes. A pre-image check can detect some concurrent modifications, but the check and the replacement are not an atomic compare-and-swap. The Shell's BashPolicy is a finite set of prohibition rules, not a container or a sandbox. Authorizing remote use of a Worker effectively also authorizes the host tool capabilities it has already exposed.

## Secrets and diagnostics have owners too

Provider credentials live in the local auth.json, and the interface receives only public settings and authentication status. The raw LLM trace keeps ordinary prompts and model text, applying a special omission only to image data. Diagnostic material must not be assumed to be already redacted.

Source code: [Python Web authentication](../../../agent/runtime/server/websocket.py), [Desktop Gateway](../../../desktop/src/main/gateway/server.ts), [credentials](../../../agent/infrastructure/credentials.py), [task notifications](../../../agent/application/task_notifications.py). Verification: [Web runtime](../../../test/test_web_runtime.py), [gateway security](../../../test/test_gateway_security.py). Details: [file tools](../04-tools/file-tools.md), [Team](../05-autonomy/teams.md), [observability](observability.md).

[Back to the series map](../README.md)
