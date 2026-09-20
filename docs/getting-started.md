# Rind setup guide

[Back to README](../README.md) · [简体中文](getting-started.zh-CN.md)

## Install the CLI

With Node.js 18+:

```bash
npm install -g @rind-ai/cli
cd your-project
rind
```

The npm package includes a platform-specific runtime dependency. Published targets are Windows x64, macOS x64/arm64, and Linux x64. Standalone CLI installers are available from [Releases](https://github.com/Azzurroooo/rind/releases).

In Rind, use `/login` to select a provider and enter an API key, then `/model` to select a model. Use `/effort` for the reasoning levels supported by the selected model. Login credentials are stored in `~/.rind/auth.json`, or under `RIND_HOME` when set.

## Custom endpoint

For an OpenAI-compatible Chat Completions endpoint, create `~/.rind/settings.json` with your endpoint, model ID, and key:

```json
{
  "provider": "openai-compatible",
  "api": "openai-chat",
  "model": "your-model-id",
  "apiKey": "your-api-key",
  "baseUrl": "https://your-endpoint.example/v1"
}
```

A complete `.rind/settings.json` in the current workspace takes precedence over the user configuration. It is selected as a whole, not merged field by field. Team agents run from their own workspace directories; use user settings to share a configuration or put a complete configuration in an individual agent's `.rind/` directory.

`RIND_HOME` changes the user data directory, whose default is `~/.rind`. It contains settings, saved credentials, sessions, and user blueprints. For native provider IDs and API dialects, see the [provider catalog](../agent/infrastructure/llm/providers.py).

## From source

Requires Python 3.12+, Node.js 18+, and Git. The source branch includes changes that may not yet be in the latest release, including the tour added after v0.8.0.

```bash
git clone https://github.com/Azzurroooo/rind.git
cd rind
python -m venv .venv
```

Activate the environment:

```bash
# macOS / Linux
source .venv/bin/activate
```

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

Then install the runtime and start the CLI:

```bash
python -m pip install -r requirements-runtime.txt
node frontend-cli/bin/rind.js
```

When following examples that use `rind`, substitute `node /absolute/path/to/rind/frontend-cli/bin/rind.js`. Keep the Python environment active; the absolute script path lets you launch from a different project or Team agent directory.

Try the tour from the repository root:

```bash
node frontend-cli/bin/rind.js tour team.create
```

It requires an interactive terminal and makes no model calls. `tour` without a page ID opens the catalog. See [Tour internals](cli-tour.md) for controls and implementation details.

## Desktop

The desktop build tools require Node.js 20.19+ within the 20.x series, or Node.js 22.12+. After setting up the Python environment above, run from the repository root:

```bash
npm --prefix desktop install
npm --prefix desktop run dev
```

The desktop app starts its own local worker. Use the same `RIND_HOME` and session directory as the CLI to access the same saved sessions.

## Web

With Docker and Compose v2, create a `.env` at the repository root:

```dotenv
RIND_SERVER_TOKEN=replace-with-a-long-random-token
RIND_WORKSPACE=/absolute/path/to/your/project
RIND_HOME=/absolute/path/to/rind-data
```

Use existing host directories for the two paths. Put your provider settings in the chosen data directory's `settings.json`. Then:

```bash
docker compose up -d --build
```

Open `http://localhost:8080` and connect using your server token. The default bind is loopback; use a private network or an authenticated TLS proxy for remote access. `RIND_WEB_PORT` and `RIND_WEB_BIND` customize the browser endpoint.

The worker keeps running when the browser disconnects. For a setup without Docker, see the [Web development instructions](../frontend-web/README.md#local-development).

## Messaging gateway

From a source checkout with the Python environment active, start a WebSocket worker in one terminal:

```bash
python main.py app-server --web --host 127.0.0.1 --port 8765 --cwd /absolute/path/to/your/project
```

In another terminal at the repository root, run the configuration wizard, then start the gateway:

```bash
python main.py gateway init --workspace /absolute/path/to/your/project
python main.py gateway --config /absolute/path/to/your/project/.rind/gateway.yaml
```

The wizard asks for the worker connection and channel credentials, confirms the workspace, and writes `.rind/gateway.yaml` there. Use the path printed by the wizard if you choose a different workspace.

Adapters include Telegram, Discord, Slack, Feishu, DingTalk, QQ, WeCom, WhatsApp Cloud, and email. Required SDKs, platform accounts, and inbound callback requirements vary by adapter. The wizard provides channel-specific guidance; `python main.py gateway doctor` checks the configuration and dependencies. For a worker with authentication enabled, provide its token in the gateway configuration.

Unknown senders can request pairing. Approve a code using `python main.py gateway approve <CODE>` with the same configuration/workspace as the running gateway.

## Development

From the repository root, with the Python environment active:

```bash
python -m pip install -r requirements.txt
python -m pytest test/ -q
npm --prefix frontend-cli install
npm --prefix frontend-cli test
```

These commands run automated regression tests. [User-scenario acceptance](../test/manual/README.md) is separate, runs only on explicit user request, and may consume live-model tokens. See the [testing guide](../test/README.md).

See [Architecture](architecture.md) for module boundaries and [CLI rendering](cli-rendering.md) for the terminal component model. The [CLI turn flow](cli-turn-flow.md) and [main pipeline](main_pipeline.md) trace execution in more detail.
