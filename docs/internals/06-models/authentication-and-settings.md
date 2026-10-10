# Configuration and credentials: choose the configuration first, then resolve the secrets

English | [简体中文](authentication-and-settings.zh-CN.md)

Rind stores model settings and login credentials in separate places. Settings come only from the user's own RIND_HOME/settings.json; credentials are resolved independently for the current provider.

~~~mermaid
flowchart TD
    U["RIND_HOME/settings.json"] --> S["effective AppSettings"]
    S --> K{"the current provider's apiKey resolvable?"}
    K -->|"yes"| C["client credentials"]
    K -->|"no"| A["the provider's credentials in auth.json"]
    A -->|"present"| C
    A -->|"absent"| E["the environment variable for that provider"]
    E --> C
~~~

## Project folders do not supply configuration

A .rind/settings.json inside a project is not read. Repository content is untrusted input: if it could decide baseUrl, it could point an already-signed-in key and its code context at any address; if it could decide serverToken, it could preset the authentication passphrase for the web runtime. Skill and RIND.md under the project's .rind/ are unaffected.

RIND_HOME defaults to ~/.rind, which changes where all user data — settings, credentials, sessions, and the like — is stored. A session's model selection can also be changed through the protocol; the default settings on disk and the current session's selection are different responsibilities.

## Connections: choosing what they point at

The provider a session saves is a connection id. Each built-in provider is a connection with the same name, usable as soon as you sign in to it. A user can also choose "Add a named endpoint" in /login, fill in a name, an OpenAI-compatible Base URL, and an optional model id and API key, and get a named connection; the id is generated from the name and must not duplicate a built-in provider's. A named connection is stored with its key in auth.json and is never written into the project folder. Signing in again with /login on the same connection replaces only the key, and /logout deletes the entire connection.

A connection's address and credentials are resolved again every time a client is assembled, so changing the key or signing in again takes effect from the next turn. When a connection referenced by a session does not exist, the turn fails outright with the reason, pointing to /login or /model; it is not silently switched to another endpoint. When the model is switched between two turns, the client and that model's image capability are replaced together.

## Where a new conversation gets its model

The default is looked up once when a session is created, and the result is written into the session meta; after that, every turn only reads the meta. Lookup order (the model group and the effort each take the first value that has been set):

1. This folder's default (RIND_HOME/workspaces.json, keyed by normalized real path);
2. If this folder is a Git worktree: the main repository folder's default (found from the .git file's gitdir, without launching git);
3. settings.json.

A model group is a connection plus a model, and the two are always set together; effort is set separately. A folder default only affects conversations created afterwards; existing conversations keep their own selection. The session meta's selection_source records whether each of the two parts came from session, folder, main_repository, or settings, and /status labels the source accordingly. Setting a folder default validates that the connection is configured, the model is in its list, and the effort is a level that model supports. The protocol methods are rind/folder_defaults/get (including inherited, the value that applies once its own setting is cleared), set, unset, resolve for parsing several folders at once, and apply for syncing an existing conversation to the folder's current default. set and unset broadcast folder_defaults_changed, and the Agents page re-reads the folder defaults it displays.

## Signing in with a ChatGPT account

/login first asks for the login method — "Sign in with an account" or "Sign in with an API key" — and then lists the providers that support that method (named connections are only on the API key side); /login <provider> only asks when that provider has both methods. Besides an API key, OpenAI also supports signing in with a ChatGPT account, which calls the OpenAI Responses API with a ChatGPT subscription. The flow is PKCE with a public client: Rind receives the browser callback on 127.0.0.1:1455 and opens the authorization page; the authorization page address is also displayed, so the final redirect address can be pasted when the browser cannot call back. Once the browser callback arrives, the authorization code is exchanged immediately (it expires quickly), and the waiting prompt in the terminal closes by itself, with no keypress needed. The token is stored in auth.json with the oauth type, together with the issued client_id; before each request, if it expires within five minutes, it is refreshed inside auth.json's lock and the new refresh token is saved. Subscription-token requests carry store:false and do not send max_output_tokens. When the port is occupied (for example by another unfinished sign-in or by the Codex CLI), /login states the reason directly.

## Minimal configuration and login

In the CLI, /login saves a provider API key, /model selects the model, and /effort adjusts the supported reasoning level. /model and /effort first change the current conversation (taking effect from the next turn), then ask exactly one follow-up question: whether to also use that value as the default for new conversations in this folder. The question is skipped when the folder is already set to that value, and it is skipped when there is no terminal UI. Ctrl+T only switches the current conversation's effort and never asks anything. There is no "all new conversations" option: the defaults for other folders come only from a manually edited settings.json. When not interactive, use rind config set model|effort <value> --folder [directory] and rind config unset model|effort --folder [directory]. Interactive login supports API keys, as well as OpenAI's ChatGPT account sign-in.

A generic Chat Completions endpoint can use the following settings.json; set MY_MODEL_KEY as a local environment variable:

~~~json
{
  "provider": "openai-compatible",
  "api": "openai-chat",
  "baseUrl": "https://your-endpoint.example/v1",
  "model": "your-model-id",
  "apiKey": "$MY_MODEL_KEY"
}
~~~

## The real limits of how credentials are stored

auth.json is a local JSON file that uses a file lock, temporary-file replacement, and best-effort file permissions; there is no OS keychain or encrypted-storage promise. A single read or write is locked, but that does not mean the whole read-modify-write transaction holds the lock throughout. The mobile secure storage holds remote connection credentials and is a different system from the Python provider credentials.

Source code: [settings loading](../../../agent/infrastructure/settings.py), [folder defaults](../../../agent/infrastructure/workspace_defaults.py), [credential storage](../../../agent/infrastructure/credentials.py), [ChatGPT sign-in](../../../agent/infrastructure/llm/chatgpt_oauth.py), [resolution and login](../../../agent/infrastructure/llm/provider_service.py). Verification: [settings loading](../../../test/test_settings_loader.py), [folder defaults](../../../test/test_workspace_defaults.py), [the protocol](../../../test/test_folder_defaults_protocol.py), [provider authentication](../../../test/test_provider_auth.py), [ChatGPT sign-in](../../../test/test_chatgpt_oauth.py), [protocol authentication interaction](../../../test/test_runtime_server_auth.py).

[Back to the series map](../README.md)
