# Rind Web Surface

The web surface connects to a long-lived Rind worker over WebSocket. Closing or refreshing the browser only closes that client connection; the worker process keeps its sessions and active turns alive.

## Run

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
