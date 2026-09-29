# Rind Desktop

Electron owns the local Worker lifecycle, native project selection, preferences, and optional
remote access. The remote Gateway lives entirely in `src/main/gateway/`; it shares the running
Worker and serves the production Web interface. No Python Worker changes are required.

## Develop and build

Use Node.js 22.19+ (22.x) or Node.js 24+, and configure the Python environment described in
`../docs/getting-started.md`. From the repository root:

```bash
npm --prefix frontend-web ci
npm --prefix desktop ci
npm --prefix desktop run build:web
npm --prefix desktop run dev
```

`build:web` is required before using remote access in development. Run it again after Web
changes, or use `frontend-web`'s Vite server for Web-only development.

```bash
npm --prefix frontend-web test
npm --prefix desktop run typecheck
npm --prefix desktop test
npm --prefix desktop run build
```

The Desktop build includes the Web build. The new `verify-surfaces.yml` workflow runs these
checks on Windows and Linux; existing CLI release workflows remain separate.

## Package

Place the platform's frozen Worker bundle in `desktop/resources/runtime`, then run:

```bash
npm --prefix desktop run package
```

The prepackage step builds both interfaces. Electron Builder copies the Worker and
`frontend-web/dist` to the installed application's `resources/runtime` and `resources/web`.
Both dependency trees must be installed before building or packaging. Packaging uses the
version in `agent/version.py`; it does not publish a release.

## Use from a phone or browser

1. Open **Remote access** in the top toolbar.
2. Keep **Local network** selected and choose **Enable remote access**.
3. Scan the QR code from the same trusted Wi-Fi network, or use **Copy sign-in link**.

The Web interface connects automatically. The address and code are also available under
**Connect manually or choose another address**. Keep the QR code and link private: they
authorize use of sessions, workspace files, and agent tools.

Remote access is off on every app launch. **Generate new code** disconnects existing clients
and invalidates unused tickets. **Turn off remote access** leaves the local Worker running;
closing Desktop ends remote access. An existing VPN or HTTPS reverse proxy can be used for
access outside the local network; Rind does not create a public tunnel.

See `../docs/surface-upgrade.md` for network setup, implementation details, and verification
boundaries.
