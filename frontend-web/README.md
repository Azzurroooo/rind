# Rind Web Surface

The web surface connects to a long-lived Rind worker over WebSocket. Closing or refreshing the browser only closes that client connection; the worker process keeps its sessions and active turns alive.

## What the console does

- **Zero-friction local connect**: the console connects directly to a tokenless loopback worker; a login card appears only when the worker demands a token. If the worker is unreachable, the empty state shows the exact startup commands, copy-ready.
- **Live turn feel**: a single status row carries the elapsed clock, the current tool activity, and the `Esc` interrupt hint; long-running tools surface heartbeats; model step retries appear as a self-clearing strip.
- **Readable long sessions**: runs of consecutive read/search calls fold into one expandable row, code blocks carry language labels and hover copy, and a turn-change chip summarizes file mutations with a jump-to-diff link.
- **Queue and steer**: submissions during a running turn queue as follow-ups (or steer, per the visible toggle); queued rows offer 取回 (back to draft) and 转向 (promote to steering).
- **Shell input habits**: ↑/↓ recall sent prompts; starters fill the composer; attachments paste, drop, and upload in the background.
- **Honest session history**: the rail shows relative times and reply previews; switching sessions replays history and re-attaches live turns, and reconnects never move the user's place.

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

## Typography & contrast rulebook

Codified from the shipped UI (`src/styles.css`). New components must follow these rules; if a rule does not fit, change the rule here first — not just the CSS.

### Token tiers

- Every color in component rules is a token (`var(--…)`). No raw hex in JSX or component rules — the light theme (`[data-theme="light"]`) re-tunes the token block only.
- Ink tiers, darkest to faintest: `--text` (headings, emphasis, selected rows) → `--content` / `--content-strong` (assistant / user message body) → `--muted` (secondary copy, labels, options) → `--dim` (mono metadata: timestamps, hints, dividers). Never go fainter than `--dim` for readable text; decorative marks only beyond it.
- Surface tiers: `--bg` (main column) → `--panel` (rail/inspector) → `--surface` → `--surface-raised` (composer, cards, palette) → `--surface-soft` (inputs, tracks). Raised surfaces may never be darker than their container in the same theme.
- Accent tokens (`--amber`, `--cyan`, `--green`, `--red`) carry meaning (attention, link/interactive, success, failure). `*-soft` variants are their tinted backgrounds. Each accent has an independently tuned value per theme so it passes AA as text on its surface — accents are not swapped by inverting, and text-on-accent uses `--accent-contrast`.

### Size floor

- 12px is the floor for any text a user is meant to read (message body is 14px; list titles 12px).
- 9–11px is reserved for `var(--mono)` metadata and uppercase micro-labels (timestamps, eyebrows, tool summaries) — never for actions or body copy the user must act on.
- Minimum interactive target: 34px desktop, 44px under `pointer: coarse` (see the media queries).

### Contrast

- Body and secondary text must meet WCAG AA (≥4.5:1; large headings ≥3:1) in both themes. The light theme values were chosen for this — do not lighten `--muted`/`--dim` further.
- No text opacity below 0.7; disabled controls use the shared `opacity: .45` rule only when the action is genuinely unavailable, and always keep `cursor: not-allowed`.
- Color never carries state alone: status uses text + icon + border (e.g. `failed` = red ink, triangle icon, `--failed-line` border).

### Type stacks & rhythm

- UI stack: `"Manrope", "Segoe UI", sans-serif` (loaded once; never per-component fonts). Code/metadata stack: `var(--mono)` = `"DM Mono", Consolas, monospace`.
- Message body 14px/1.75; compact UI text 12px/1.45–1.5; code blocks 12px/1.6; metadata mono 10–11px/1.4.
- Headings use negative letter-spacing (`-.02em` to `-.035em`) and `text-wrap: balance`; body copy uses `text-wrap: pretty`; all text uses `overflow-wrap: anywhere` where user-generated content can appear.
- Motion respects `prefers-reduced-motion: reduce` (global override); durations stay within `--t-fast/base/slow` (≤280ms).

