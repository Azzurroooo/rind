"""Channel adapter registry (gateway.md §8): channel id → lazy loader.

Each adapter module imports its SDK lazily, so a missing optional dependency
disables exactly that channel with a one-line log while the gateway process
keeps running (§1).  Channels start only when present under ``channels:`` in
gateway.yaml — the never-import rule for unconfigured SDKs falls out of the
lazy ``importlib`` call here.
"""

from __future__ import annotations

import importlib
import logging
from pathlib import Path

from .. import Channel
from ..config import ChannelConfig

logger = logging.getLogger(__name__)

#: channel id → "module:builder"; modules imported on first use only.
LOADERS: dict[str, str] = {
    "telegram": "gateway.channels.telegram:build_channel",
    "discord": "gateway.channels.discord:build_channel",
}


def build_channel(channel_id: str, config: ChannelConfig, uploads_root: Path) -> Channel | None:
    """Instantiate one adapter, or return None (after one log line) to disable.

    Startup failures — unknown id, missing SDK, bad token — never raise into
    the gateway loop (gateway.md §1: log a line, keep the process up).
    """
    spec = LOADERS.get(channel_id)
    if spec is None:
        logger.warning("gateway: no adapter installed for channel %r; channel disabled", channel_id)
        return None
    module_name, _, attribute = spec.partition(":")
    try:
        builder = getattr(importlib.import_module(module_name), attribute)
        return builder(config, Path(uploads_root))
    except Exception as exc:
        logger.warning("gateway: channel %s failed to start; disabled: %s", channel_id, exc)
        return None


__all__ = ["LOADERS", "build_channel"]
