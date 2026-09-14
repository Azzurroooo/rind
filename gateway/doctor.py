"""`gateway doctor`: one checklist for "why is my channel silent".

Each check answers a question a user would actually ask, in order:
does the config exist → does it parse → is the worker reachable → per-channel
SDK installed and credentials valid → are the state files intact.
`--probe` adds live credential checks; `--fix` repairs what
can be repaired automatically (corrupt state files get a .corrupt backup).
"""

from __future__ import annotations

import asyncio
import importlib
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import ConfigError, load_config
from .onboarding import GUIDES
from .status import _worker_alive


@dataclass
class CheckResult:
    name: str
    ok: bool | None  # None = warning
    detail: str
    fix: str = ""


def _read_json(path: Path) -> tuple[bool, Any]:
    try:
        return True, json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return True, None  # missing is fine (fresh install)
    except Exception:
        return False, None


def _fix_corrupt(path: Path) -> str:
    backup = path.with_name(path.name + ".corrupt")
    try:
        path.rename(backup)
        return f"backed up as {backup.name}"
    except OSError as exc:
        return f"rename failed: {exc}"


def sdk_missing(sdk_module: str) -> bool:
    try:
        importlib.import_module(sdk_module)
        return False
    except ImportError:
        return True


def ensure_sdk_installed(sdk_module: str, *, runner=None) -> tuple[bool, str]:
    """pip install a channel SDK on the user's behalf; (ok, detail).

    `runner` is injectable for tests. After installing, the import cache is
    invalidated so the lazy adapter loader picks the SDK up immediately.
    """
    try:
        importlib.import_module(sdk_module)
        return True, "already installed"
    except ImportError:
        pass
    run = runner or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True))
    result = run([sys.executable, "-m", "pip", "install", sdk_module])
    if getattr(result, "returncode", 1) != 0:
        tail = (getattr(result, "stderr", "") or "").strip().splitlines()[-1:] or ["pip failed"]
        return False, f"pip install {sdk_module} failed: {tail[0]}"
    importlib.invalidate_caches()
    try:
        importlib.import_module(sdk_module)
        return True, f"auto-installed {sdk_module}"
    except ImportError as exc:
        return False, f"{sdk_module} still not importable after install: {exc}"


def _looks_like_source_dir(path: Path) -> bool:
    """Runtime data must never land in the Rind source tree (main.py + gateway/)."""
    return (path / "main.py").is_file() and (path / "gateway").is_dir()


def ensure_channel_sdks(guides, *, interactive: bool, confirm=None, echo=print):
    """Auto pip-install missing channel SDKs; returns (kept guides, self-heal enabled).

    One-shot mode installs directly; interactive mode asks first (confirm is
    injectable — the wizard passes its own prompt function; defaults to
    prompt.confirm). Failure or user refusal → the channel is dropped from
    this configuration. RIND_GATEWAY_NO_AUTO_INSTALL=1 disables it entirely
    (tests/CI).
    """
    import os

    if confirm is None:
        from .prompt import confirm as _confirm_impl

        confirm = _confirm_impl

    if os.environ.get("RIND_GATEWAY_NO_AUTO_INSTALL"):
        return guides, False
    kept = []
    for guide in guides:
        needed = ([guide.sdk_module] if guide.sdk_module else []) + list(guide.runtime_deps)
        missing = [module for module in needed if sdk_missing(module)]
        if not missing:
            kept.append(guide)
            continue
        if interactive:
            names = ", ".join(missing)
            if not confirm(f"Channel {guide.label} needs {names} (not installed). Install automatically?"):
                echo(f"  Skipped {guide.label}: channels with missing dependencies are not written to the config.")
                continue
        installed_ok = True
        for module in missing:
            echo(f"  Installing {module} …")
            ok, detail = ensure_sdk_installed(module)
            echo(f"  {'✔' if ok else '✘'} {detail}")
            if not ok:
                echo(f"  Skipped {guide.label}. Install manually: pip install {module}")
                installed_ok = False
        if installed_ok:
            kept.append(guide)
    return kept, bool(kept)


def run_checks(config_path: Path | None, workspace: Path, *, probe: bool = False, fix: bool = False) -> list[CheckResult]:
    results: list[CheckResult] = []

    def add(name: str, ok: bool | None, detail: str, fix: str = "") -> None:
        results.append(CheckResult(name, ok, detail, fix))

    path = config_path or (workspace / ".rind" / "gateway.yaml")
    if not path.is_file():
        add(
            "config file",
            False,
            f"not found: {path}",
            "run `python main.py gateway init` to create one (about 2 minutes)",
        )
        return results

    try:
        config = load_config(path)
        add("config file", True, f"{path} parses cleanly")
    except ConfigError as exc:
        add("config file", False, str(exc), "fix per the message and rerun, or regenerate with `gateway init`")
        return results

    # worker reachability: real WS handshake by default — never guess "is it up"
    worker = config.worker
    if worker == "stdio":
        add("worker connection", True, "stdio mode: the gateway spawns the worker subprocess itself")
    else:
        alive, detail = asyncio.run(_worker_alive(worker, config.worker_token, timeout=5.0))
        add(
            "worker connection",
            True if alive else False,
            f"{worker} — {detail}",
            fix="" if alive else "confirm the worker is running (python main.py app-server --web ...) and the worker_token matches",
        )

    ws_dir = Path(config.workspace)
    if not ws_dir.is_dir():
        add("workspace directory", False, f"directory missing: {config.workspace}", "set workspace in gateway.yaml to an absolute path")
    elif _looks_like_source_dir(ws_dir):
        add(
            "workspace directory",
            None,
            f"{config.workspace} looks like the Rind source tree — runtime data (state/pairing/uploads) would mix into it",
            "use a dedicated directory for gateway sessions (e.g. ~/rind-workspace)",
        )
    else:
        add("workspace directory", True, config.workspace)

    runtime_dir = Path(config.workspace) / ".rind"
    for name in ("state.json", "pairing.json"):
        target = runtime_dir / name
        readable, data = _read_json(target)
        if readable:
            add(name, True, "readable" if data else "not created yet (appears after first run)")
        elif fix:
            add(name, True, f"corrupt, {_fix_corrupt(target)} (reset)")
        else:
            add(name, False, "corrupt", "add --fix to back up and reset automatically")

    for channel_id, channel in config.channels.items():
        guide = GUIDES.get(channel_id)
        label = guide.label if guide else channel_id
        sdk_module = guide.sdk_module if guide else ""
        sdk_ok = True
        if sdk_module:
            try:
                importlib.import_module(sdk_module)
            except Exception:  # noqa: BLE001 - SDKs are optional; a missing one only affects this channel
                sdk_ok = False
                add(f"channel {label}", False, f"SDK not installed: pip install {sdk_module}")
        if not sdk_ok:
            continue
        if guide is not None and guide.probe and probe:
            answers = {"token": channel.token, **channel.extra}
            required = [spec.name for spec in guide.fields if spec.required]
            missing = [name for name in required if not answers.get(name)]
            if missing:
                add(f"channel {label}", False, f"missing required fields: {', '.join(missing)}")
                continue
            result = guide.probe({key: value for key, value in answers.items() if value})
            add(f"channel {label} credentials", result.ok, result.detail)
        else:
            add(f"channel {label}", True, "configured (add --probe to verify credentials)")

    if not config.channels:
        add("channels", None, "no channels configured yet", "run `python main.py gateway init` to add one")
    return results


def run_doctor(args) -> int:
    workspace = Path(args.workspace).expanduser().resolve()
    config_path = Path(args.config) if args.config else None
    results = run_checks(config_path, workspace, probe=bool(args.probe), fix=bool(args.fix))
    print("Rind gateway health check")
    failed = 0
    for check in results:
        if check.ok is True:
            mark = "✔"
        elif check.ok is None:
            mark = "⚠"
        else:
            mark = "✘"
            failed += 1
        print(f"  {mark} {check.name}: {check.detail}")
        if check.fix and not check.ok:
            print(f"      ↳ {check.fix}")
    if failed == 0:
        print("All checks passed. Start: python main.py gateway --config <config path>")
        return 0
    print(f"{failed} check(s) failed.", file=sys.stderr)
    return 1


__all__ = ["run_checks", "run_doctor"]
