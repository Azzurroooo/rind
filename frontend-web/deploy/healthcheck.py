"""Compose healthcheck: the worker must answer GET /healthz without credentials."""

import urllib.request


def check_worker() -> None:
    with urllib.request.urlopen("http://127.0.0.1:8765/healthz", timeout=2) as response:
        if response.status != 200:
            raise SystemExit(f"unexpected health status: {response.status}")


check_worker()
