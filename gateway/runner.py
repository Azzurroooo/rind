"""Gateway execution shared by the command entrypoint and setup wizard."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from .channels import build_channel
from .config import GatewayConfig
from .pump import TurnPump
from .router import SessionRouter
from .security import CooldownGate, PairingStore, SecurityGate
from .worker_client import WorkerClient, WorkerError

logger = logging.getLogger(__name__)


async def run_gateway(config: GatewayConfig, runtime_dir: Path, pairing: PairingStore) -> int:
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


