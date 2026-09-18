"""Gateway process entry: config → worker client → channels → pump loop.

Also hosts the out-of-process pairing approval: ``python main.py gateway
approve <CODE>`` reads and writes the same pairing.json as the running
gateway, so approval never needs the bot process to restart.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from .config import ConfigError, load_config, resolve_config_path
from .security import PairingStore
from .runner import run_gateway



def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gateway", description="Rind unified message gateway")
    parser.add_argument("--config", default=None, help="gateway.yaml path (default <workspace>/.rind/gateway.yaml)")
    parser.add_argument("--workspace", default=".", help="Workspace root used for config/state lookup")
    subparsers = parser.add_subparsers(dest="command")
    approve = subparsers.add_parser("approve", help="Approve a pending pairing code")
    approve.add_argument("code", help="The 6-character pairing code shown to the sender")
    init = subparsers.add_parser("init", help="Create gateway.yaml interactively (per-channel guidance + live credential checks + automatic account-ID capture)")
    init.add_argument("--channel", default="", help="Comma-separated channel ids (e.g. telegram,email; skips the selection menu)")
    init.add_argument("--yes", action="store_true", help="Non-interactive one-shot mode: all fields come from RIND_GW_<CHANNEL>_<FIELD> environment variables")
    init.add_argument("--worker-url", default="", help="Worker URL (default ws://127.0.0.1:8765)")
    init.add_argument("--workspace", default=None, help="Workspace directory (default: current directory)")
    doctor = subparsers.add_parser("doctor", help="Item-by-item health check: config/worker/SDK/credentials/state files (--probe tests credentials live, --fix auto-repairs)")
    doctor.add_argument("--probe", action="store_true", help="Verify channel credentials live (calls platform APIs)")
    doctor.add_argument("--fix", action="store_true", help="Auto-repair what can be repaired (corrupt state files are backed up as .corrupt)")
    doctor.add_argument("--config", default=None, help="gateway.yaml path")
    doctor.add_argument("--workspace", default=".", help="Workspace root")
    status = subparsers.add_parser("status", help="One-screen status: session mappings/pairing/channels/worker liveness")
    status.add_argument("--config", default=None, help="gateway.yaml path")
    status.add_argument("--workspace", default=".", help="Workspace root")
    subparsers.add_parser("start", help="Start the gateway (same as running without a subcommand)")
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = build_parser().parse_args(list(sys.argv[1:] if argv is None else argv))
    # init owns its workspace prompting (default None on the subparser); every
    # other path resolves against the current directory.
    workspace = Path(args.workspace or ".").expanduser().resolve()

    if args.command == "init":
        from .wizard import run_init

        return run_init(args)
    if args.command == "doctor":
        from .doctor import run_doctor

        return run_doctor(args)
    if args.command == "status":
        from .status import run_status

        return run_status(args)
    if args.command == "start":
        args.command = "run"  # start equals bare invocation; an explicit verb for the wizard and docs

    # Approving a pairing code only needs pairing.json — never require (or
    # even read) gateway.yaml, so approval works on a machine without config.
    if args.command == "approve":
        pairing = PairingStore(workspace / ".rind" / "pairing.json")
        if pairing.approve(args.code):
            print(f"Pairing approved: {args.code.strip().upper()}")
            return 0
        print(f"Pairing code invalid or expired: {args.code}", file=sys.stderr)
        return 1

    try:
        config = load_config(resolve_config_path(args.config, workspace))
    except ConfigError as exc:
        # The wizard is not tty-gated: piped "Y\n" works too (automation and
        # tests); end of input (EOF) cancels quietly.
        print(f"gateway: {exc}")
        try:
            offer = input("Run the configuration wizard (gateway init) now? [Y/n]: ").strip().lower()
        except EOFError:
            offer = "n"
        if offer in ("", "y", "yes"):
            from types import SimpleNamespace

            from .wizard import run_init

            # The base parser has no init-only flags; give the wizard the
            # namespace shape it expects (interactive mode, wizard's own
            # prompts for worker/workspace).
            return run_init(
                SimpleNamespace(
                    command="init", config=None, channel="", yes=False,
                    worker_url="", workspace=str(workspace),
                )
            )
        print("Run `python main.py gateway init` to create the config interactively.", file=sys.stderr)
        return 2
    runtime_dir = Path(config.workspace) / ".rind"
    pairing = PairingStore(runtime_dir / "pairing.json")
    try:
        return asyncio.run(run_gateway(config, runtime_dir, pairing))
    except KeyboardInterrupt:
        return 0
    except RuntimeError as exc:  # capability gate: worker needs upgrading first
        print(f"gateway: {exc}", file=sys.stderr)
        return 1


__all__ = ["main"]
