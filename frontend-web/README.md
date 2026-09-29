# Rind Web Surface

The web surface connects to a long-lived Rind worker over WebSocket. Closing or refreshing the browser only closes that client connection; the worker process keeps its sessions and active turns alive.

## Connect through Rind Desktop

In Desktop, open **Remote access** from the top toolbar and choose **Enable remote access**.
Scan the QR code with a phone on the same trusted network, or copy the sign-in link to another
browser. The page connects automatically; no server or WebSocket address setup is needed.
Manual address and access-code entry is available in the desktop dialog as a fallback.

Remote access is off by default. Keep Desktop running. **Generate new code** disconnects
previous devices; **Turn off remote access** stops sharing without stopping local tasks.
See `../docs/surface-upgrade.md` for HTTPS/private-network setup and validation boundaries.

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
npm ci
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173` and use the worker's access token on the sign-in screen. The Vite
proxy connects `/ws` and `/ticket` to the local worker automatically. For a developer-managed
deployment, configure the reverse proxy or `VITE_RIND_WS_URL` at build time. Ordinary users
never configure transport addresses in the interface.

The default worker bind host is loopback. Use a reverse proxy with authentication and TLS before exposing a worker outside a trusted network.

## Typography & contrast rulebook

Codified from the shipped UI (`src/styles.css`). New components must follow these rules; if a rule does not fit, change the rule here first — not just the CSS.

### Token tiers

- Every color in component rules is a token (`var(--…)`). No raw hex in JSX or component rules — the light theme (`[data-theme="light"]`) re-tunes the token block only.
- Ink tiers, darkest to faintest: `--text` (headings, emphasis, selected rows) → `--content` / `--content-strong` (assistant / user message body) → `--muted` (secondary copy, labels, options) → `--dim` (mono metadata: timestamps, hints, dividers). Never go fainter than `--dim` for readable text; decorative marks only beyond it.
- Surface tiers: `--bg` (main column) → `--panel` (rail/inspector) → `--surface` → `--surface-raised` (composer, cards, palette) → `--surface-soft` (inputs, tracks). Raised surfaces may never be darker than their container in the same theme.
- Accent tokens (`--amber`, `--cyan`, `--green`, `--red`) carry meaning (attention, link/interactive, success, failure). `*-soft` variants are their tinted backgrounds. Each accent has an independently tuned value per theme so it passes AA as text on its surface — accents are not swapped by inverting, and text-on-accent uses `--accent-contrast`.

### Size floor

- 12px is the floor for any text a user is meant to read (message body is 15px; list titles 12px).
- 9–11px is reserved for `var(--mono)` metadata and uppercase micro-labels (timestamps, eyebrows, tool summaries) — never for actions or body copy the user must act on.
- Minimum interactive target: 34px desktop, 44px under `pointer: coarse` (see the media queries).

### Contrast

- Body and secondary text must meet WCAG AA (≥4.5:1; large headings ≥3:1) in both themes. The light theme values were chosen for this — do not lighten `--muted`/`--dim` further.
- No text opacity below 0.7; disabled controls use the shared `opacity: .45` rule only when the action is genuinely unavailable, and always keep `cursor: not-allowed`.
- Color never carries state alone: status uses text + icon + border (e.g. `failed` = red ink, triangle icon, `--failed-line` border).

### Type stacks & rhythm

- UI stack: `Inter, "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif`. Code/metadata stack: `var(--mono)` = `"Cascadia Code", Consolas, monospace`. Fonts resolve locally without external font requests.
- Message body 15px/1.8; compact UI text 12–14px; code blocks 12px/1.6; metadata mono 10–11px/1.4.
- Headings use negative letter-spacing (`-.02em` to `-.035em`) and `text-wrap: balance`; body copy uses `text-wrap: pretty`; all text uses `overflow-wrap: anywhere` where user-generated content can appear.
- Motion respects `prefers-reduced-motion: reduce` (global override); durations stay within `--t-fast/base/slow` (≤280ms).

