# Rind Web Surface

The web surface connects to a long-lived Rind worker over WebSocket. Closing or refreshing the browser only closes that client connection; the worker process keeps its sessions and active turns alive.

## One-command deployment

Install Docker Desktop or Docker Engine with Compose v2, then run from the repository root:

```bash
docker compose up -d --build
```

Open `http://localhost:8080`. The command builds the web surface and starts the long-lived WebSocket worker behind the same origin. The current directory is mounted as the workspace and `./.rind` stores settings and sessions. Set `RIND_WORKSPACE`, `RIND_HOME`, `RIND_WEB_PORT`, `RIND_WEB_BIND`, `RIND_PYPI_INDEX_URL`, or `RIND_DEBIAN_MIRROR` in a `.env` file to override them. The default bind is `127.0.0.1`.

Stop the deployment with:

```bash
docker compose down
```

## Local development

Start the worker from the repository root:

```bash
python main.py app-server --web --host 127.0.0.1 --port 8765 --cwd <workspace>
```

Leave out `--session-dir` to share the default `~/.rind/sessions` and session index with the CLI. If the CLI uses a custom `--session-dir` or `RIND_HOME`, start the Web worker with the same setting.

Start the web surface in another terminal:

```bash
cd frontend-web
npm install
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173`. To connect to another worker, edit the WebSocket URL in the top bar or use `?ws=ws://host:8765`.

The default worker bind host is loopback. Use a reverse proxy with authentication and TLS before exposing a worker outside a trusted network.
