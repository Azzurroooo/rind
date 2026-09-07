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
    workspace = Path(args.workspace).expanduser().resolve()
    try:
        config = load_config(resolve_config_path(args.config, workspace))
    except ConfigError as exc:
        print(f"gateway: {exc}", file=sys.stderr)
        return 2
    runtime_dir = Path(config.workspace) / ".rind"
    pairing = PairingStore(runtime_dir / "pairing.json")
    if args.command == "approve":
        if pairing.approve(args.code):
            print(f"已批准配对：{args.code.strip().upper()}")
            return 0
        print(f"配对码无效或已过期：{args.code}", file=sys.stderr)
        return 1
    try:
        return asyncio.run(_run(config, runtime_dir, pairing))
    except KeyboardInterrupt:
        return 0
    except RuntimeError as exc:  # capability gate: worker needs upgrading first
        print(f"gateway: {exc}", file=sys.stderr)
        return 1


__all__ = ["main"]
