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

from .channels import build_channel
from .config import ConfigError, GatewayConfig, load_config, resolve_config_path
from .pump import TurnPump
from .router import SessionRouter
from .security import CooldownGate, PairingStore, SecurityGate
from .worker_client import WorkerClient, WorkerError

logger = logging.getLogger(__name__)


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


async def _run(config: GatewayConfig, runtime_dir: Path, pairing: PairingStore) -> int:
    router = SessionRouter(runtime_dir / "state.json")

    def cursor_for(session_id: str) -> int:
        key = router.key_for_session(session_id)
        return router.cursor_for(key) if key else 0

    worker = WorkerClient(config.worker, config.worker_token, cursor_provider=cursor_for)
    security = SecurityGate(
        pairing=pairing,
        cooldown=CooldownGate(config.cooldown_per_minute),
        allow_from={channel_id: channel.allow_from for channel_id, channel in config.channels.items()},
        group_allow={channel_id: channel.group_allow for channel_id, channel in config.channels.items()},
        pairing_enabled=config.pairing.enabled,
        pairing_ttl_seconds=config.pairing.ttl_minutes * 60,
    )
    pump = TurnPump(worker=worker, router=router, security=security, workspace_root=config.workspace)
    await worker.start()  # connect + initialize + capability gate
    for key, record in router.all_sessions().items():
        try:
            await worker.subscribe(record.session_id)
        except WorkerError as exc:
            logger.warning("gateway: resubscribe of %s failed: %s", key, exc)
    uploads_root = Path(config.workspace) / config.uploads_dir
    for channel_id, channel_config in config.channels.items():
        channel = build_channel(channel_id, channel_config, uploads_root)
        if channel is None and config.auto_install_sdk:
            # Self-heal on missing SDK: install and rebuild once (users who accepted
            # auto_install_sdk in the wizard shouldn't be blocked by "pip install xxx").
            from .doctor import ensure_sdk_installed
            from .onboarding import guide_for

            guide = guide_for(channel_id)
            if guide is not None:
                for module in [guide.sdk_module, *guide.runtime_deps]:
                    if module:
                        ok, detail = ensure_sdk_installed(module)
                        logger.info("gateway: auto-install %s for channel %s: %s", module, channel_id, detail)
                channel = build_channel(channel_id, channel_config, uploads_root)
        if channel is None:  # registry already logged why (unknown id / SDK / config)
            continue
        pump.register_channel(channel)
        try:
            # The pump is the adapters' sink: they normalize SDK events into
            # InboundMessage and call back through pump.inbound (§8).
            await channel.start(pump)
        except Exception as exc:  # §1: one failing channel never stops the process
            logger.warning("gateway: channel %s failed to start; disabled: %s", channel_id, exc)
    scan = asyncio.create_task(pump.run(), name="gateway-scan")
    try:
        await scan
    finally:
        await worker.stop()
    return 0


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
        return asyncio.run(_run(config, runtime_dir, pairing))
    except KeyboardInterrupt:
        return 0
    except RuntimeError as exc:  # capability gate: worker needs upgrading first
        print(f"gateway: {exc}", file=sys.stderr)
        return 1


__all__ = ["main"]
