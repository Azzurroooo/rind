"""`gateway init`: guided, per-channel configuration instead of a YAML wall.

The interactive loop (input/print) is thin; the actual work lives in pure
functions — `collect_answers_env` (one-click env-driven mode) and
`build_config_data` (answers → gateway.yaml dict) — so the whole flow is
unit-testable without a terminal.
"""

from __future__ import annotations

import asyncio
import getpass
import os
import sys
from pathlib import Path
from typing import Any

from .config import build_config, parse_yaml, render_yaml
from .prompt import WizardCancelled, ask as _ask, ask_list as _ask_list, confirm as _confirm, pick_channels as _pick_channels
from .onboarding import ChannelGuide, all_guides, guide_for

DEFAULT_WORKER = "ws://127.0.0.1:8765"


# --- pure builders -------------------------------------------------------------


def env_answer(channel_id: str, field_name: str, env: dict[str, str]) -> str:
    return env.get(f"RIND_GW_{channel_id.upper()}_{field_name.upper()}", "")


def collect_answers_env(guide: ChannelGuide, env: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Non-interactive mode: read every field from RIND_GW_<CH>_<FIELD>."""
    answers: dict[str, str] = {}
    missing_required: list[str] = []
    for spec in guide.fields:
        value = env_answer(guide.id, spec.name, env) or (spec.default if spec.default else "")
        answers[spec.name] = value
        if spec.required and not value:
            missing_required.append(f"RIND_GW_{guide.id.upper()}_{spec.name.upper()}")
    allow = env_answer(guide.id, "allow_from", env)
    group = env_answer(guide.id, "group_allow", env)
    lists = {
        "allow_from": [item.strip() for item in allow.split(",") if item.strip()],
        "group_allow": [item.strip() for item in group.split(",") if item.strip()],
    }
    return {"answers": answers, **lists}, missing_required


def build_config_data(
    selected: list[str],
    answers: dict[str, dict[str, str]],
    lists: dict[str, dict[str, list[str]]],
    *,
    worker: str,
    worker_token: str,
    workspace: str,
    pairing_enabled: bool = True,
    auto_install_sdk: bool = False,
) -> dict[str, Any]:
    channels: dict[str, Any] = {}
    for channel_id in selected:
        guide = guide_for(channel_id)
        if guide is None:
            continue
        block: dict[str, Any] = {}
        for spec in guide.fields:
            value = answers.get(channel_id, {}).get(spec.name, "")
            if value:
                block[spec.name] = int(value) if value.isdigit() and spec.name in {"imap_port", "smtp_port", "poll_interval", "callback_port", "webhook_port", "ws_port"} else value
        allow = [item for item in lists.get(channel_id, {}).get("allow_from", []) if item]
        group = [item for item in lists.get(channel_id, {}).get("group_allow", []) if item]
        if allow:
            block["allow_from"] = allow
        if group:
            block["group_allow"] = group
        if block:
            channels[channel_id] = block
    data: dict[str, Any] = {
        "worker": worker,
        "workspace": workspace,
        "channels": channels,
    }
    if worker_token:
        data["worker_token"] = worker_token
    if pairing_enabled:
        data["pairing"] = {"enabled": True}
    if auto_install_sdk:
        data["auto_install_sdk"] = True
    return data


def config_path_for(workspace: str) -> Path:
    return Path(workspace).expanduser() / ".rind" / "gateway.yaml"


def _guide_walk(guide: ChannelGuide, env: dict[str, str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    print(f"\n=== {guide.emoji} {guide.label} ===")
    for step in guide.setup_steps:
        print(f"  · {step}")
    if guide.scopes:
        print("  Exact permission/event codes (paste each into the platform's search box to pin them down):")
        for code in guide.scopes:
            print(f"      {code}")
    answers: dict[str, str] = {}
    env_prefix = f"RIND_GW_{guide.id.upper()}_"
    for spec in guide.fields:
        env_value = env.get(env_prefix + spec.name.upper(), "")
        label = f"{spec.label}" + (f" ({spec.help})" if spec.help else "")
        answers[spec.name] = _ask(label, spec.default, secret=spec.secret) or env_value
    print("  allow_from / group_allow can stay empty — unknown accounts get a pairing code on their first message,")
    print("  and `gateway approve <code>` on the server adds them to the allowlist automatically.")
    allow = _ask_list("allow_from allowlist")
    group = _ask_list("group_allow group allowlist")
    probe_detail = ""
    if guide.probe and answers:
        if _confirm("Verify credentials now (calls the platform API)?"):
            result = guide.probe({key: value for key, value in answers.items() if value})
            probe_detail = result.detail
            mark = "✔" if result.ok else "✘"
            print(f"  {mark} {probe_detail}")
            # Probe failure (often a direct-connection timeout on blocked networks): offer a proxy retry.
            retries = 0
            while not result.ok and retries < 2 and _confirm("Re-enter the proxy URL and verify again?", default_yes=False):
                answers["proxy"] = _ask("Proxy URL (e.g. http://127.0.0.1:7890)")
                result = guide.probe({key: value for key, value in answers.items() if value})
                probe_detail = result.detail
                mark = "✔" if result.ok else "✘"
                print(f"  {mark} {probe_detail}")
                retries += 1
            if not result.ok:
                print("     You can re-run the health check later with `python main.py gateway doctor --probe`.")
    if guide.discover_senders:
        import re

        bot_match = re.search(r"@[\w]+", probe_detail)
        where = f"send your bot {bot_match.group(0)} a message on Telegram" if bot_match else "find your bot on Telegram (the username BotFather gave you) and send it a message"
        if _confirm(f"Capture your account ID now? (within 60 seconds, {where})", default_yes=False):
            print(f"  Waiting for a message — send anything to {bot_match.group(0) if bot_match else 'your bot'} on Telegram…")
            senders = guide.discover_senders({key: value for key, value in answers.items() if value}, 60.0)
            if senders:
                print("  Discovered senders:")
                for index, sender in enumerate(senders, start=1):
                    print(f"    {index}. {sender}")
                picked = _input("Add which to allow_from (numbers, Enter = all, 0 = none): ").strip()
                if picked != "0":
                    ids = [senders[int(token) - 1].split(" ")[0] for token in picked.replace("，", ",").split(",") if token.strip().isdigit() and 0 < int(token) <= len(senders)] if picked else [sender.split(" ")[0] for sender in senders]
                    allow = allow or ids
            else:
                print("  No message within 60 seconds. Messaging the bot later returns a pairing card (with your ID);")
                print("  approve it with `gateway approve <code>` — no need to rerun the wizard.")
    return answers, {"allow_from": allow, "group_allow": group}


def _default_workspace() -> str:
    """Runtime data never defaults into the Rind source tree — fall back to a dedicated workspace under the user's home."""
    cwd = Path(os.getcwd())
    from .doctor import _looks_like_source_dir

    if _looks_like_source_dir(cwd):
        return str(Path.home() / "rind-workspace")
    return str(cwd)


def _resolve_workspace(raw: str | None) -> str:
    from .doctor import _looks_like_source_dir

    candidate = Path(raw or _default_workspace()).expanduser()
    if _looks_like_source_dir(candidate):
        print("  ✘ This is the Rind source tree — runtime data (state/pairing/uploads) must not live here.")
        fallback = Path.home() / "rind-workspace"
        value = Path(_input(f"Pick another workspace directory (Enter = {fallback}): ").strip() or str(fallback)).expanduser()
        if _looks_like_source_dir(value):
            print("  ✘ Still the source tree. Cancelled.")
            raise WizardCancelled()
        candidate = value
    candidate.mkdir(parents=True, exist_ok=True)
    return str(candidate.resolve())


def run_init(args) -> int:
    env = dict(os.environ)
    if args.yes:
        # One-shot mode: fully non-interactive — channels, fields, and connection info all come from args and env.
        selected = [token.strip() for token in args.channel.split(",") if guide_for(token.strip())]
        unknown = [token.strip() for token in args.channel.split(",") if not guide_for(token.strip())]
        if unknown:
            print(f"Unknown channels ignored: {', '.join(unknown)}", file=sys.stderr)
        if not selected:
            print("--channel has no valid channels.", file=sys.stderr)
            return 2
        worker = args.worker_url or env.get("RIND_GW_WORKER") or DEFAULT_WORKER
        worker_token = env.get("RIND_SERVER_TOKEN", "")
        workspace = _resolve_workspace(args.workspace)
        guides = [guide_for(channel_id) for channel_id in selected]
        answers: dict[str, dict[str, str]] = {}
        lists: dict[str, dict[str, list[str]]] = {}
        for guide in guides:
            collected, missing = collect_answers_env(guide, env)
            answers[guide.id] = collected["answers"]
            lists[guide.id] = {key: collected[key] for key in ("allow_from", "group_allow")}
            if missing:
                print(f"✘ {guide.label} is missing required fields (environment variables): {', '.join(missing)}", file=sys.stderr)
                return 2
        from .doctor import ensure_channel_sdks
        guides, auto_install = ensure_channel_sdks(guides, interactive=False)
        if not guides:
            print("No channels available to start.", file=sys.stderr)
            return 2
        return _finish(args, selected, answers, lists, worker, worker_token, workspace, confirm=False, auto_install_sdk=auto_install)

    print("Rind gateway configuration wizard — connect IM channels to your worker step by step (about 2 minutes)")
    try:
        if args.channel:
            selected = [token.strip() for token in args.channel.split(",") if guide_for(token.strip())]
            unknown = [token.strip() for token in args.channel.split(",") if not guide_for(token.strip())]
            if unknown:
                print(f"Unknown channels ignored: {', '.join(unknown)}", file=sys.stderr)
            if not selected:
                print("No usable channels.", file=sys.stderr)
                return 2
        else:
            selected = _pick_channels()
        worker_token = os.environ.get("RIND_SERVER_TOKEN", "")
        worker = _ask("Worker URL", args.worker_url or DEFAULT_WORKER)
        workspace = _resolve_workspace(_ask("Workspace directory (root for gateway sessions, absolute path)", args.workspace or _default_workspace()))
        if not worker_token:
            worker_token = _ask("Worker Token (value of RIND_SERVER_TOKEN, optional)", secret=True)

        guides = [guide_for(channel_id) for channel_id in selected]
        from .doctor import ensure_channel_sdks

        guides, auto_install = ensure_channel_sdks(guides, interactive=True)
        if not guides:
            print("No channels available to start.", file=sys.stderr)
            return 2
        answers = {}
        lists = {}
        for guide in guides:
            answers[guide.id], lists[guide.id] = _guide_walk(guide, env)
    except WizardCancelled:
        print("\nCancelled (nothing written).")
        return 1
    return _finish(args, selected, answers, lists, worker, worker_token, workspace, confirm=True, auto_install_sdk=auto_install)


def _finish(args, selected, answers, lists, worker, worker_token, workspace, *, confirm: bool, auto_install_sdk: bool = False) -> int:
    data = build_config_data(
        selected, answers, lists,
        worker=worker, worker_token=worker_token, workspace=str(workspace),
        auto_install_sdk=auto_install_sdk,
    )
    text = render_yaml(data)
    print("\n—— Generated gateway.yaml ——")
    print(text)
    target = config_path_for(str(workspace))
    if confirm and not _confirm(f"Write to {target}?"):
        print("Cancelled (nothing written).")
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    print(f"\n✔ Written to {target}")

    # Wrap-up: the wizard owns the health check and startup — the user never copies commands.
    from .doctor import run_checks

    print("\n—— Health check ——")
    for check in run_checks(target, Path(workspace)):
        mark = "✔" if check.ok is True else ("⚠" if check.ok is None else "✘")
        print(f"  {mark} {check.name}: {check.detail}")

    print("\nNext: start the gateway to begin chatting.")
    print(f"  python main.py gateway --config \"{target}\"")
    print("  (add/change channels: rerun python main.py gateway init)")

    # Startup owned by the wizard: interactive terminals launch by default (EOF/pipe skips quietly — automation-friendly).
    try:
        start_now = _confirm("Start the gateway now? (Ctrl+C to stop)", default_yes=True)
    except WizardCancelled:
        start_now = False
    if not start_now:
        return 0

    from .main import _run
    from .security import PairingStore

    runtime_dir = Path(workspace) / ".rind"
    config = build_config(parse_yaml(text, env=os.environ))
    try:
        return asyncio.run(_run(config, runtime_dir, PairingStore(runtime_dir / "pairing.json")))
    except KeyboardInterrupt:
        print("\nGateway stopped.")
        return 0


__all__ = ["build_config_data", "collect_answers_env", "config_path_for", "run_init"]
