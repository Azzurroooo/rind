"""Outbound delivery: everything the pump pushes to a channel (gateway.md §5).

Capability-gated mechanics only — no session decisions live here: typing
keepalive tasks, question cards (native buttons or pre-rendered numbered
list), chunked assistant text with the one-line task title, and the optional
✅ reaction hook.  Channel adapters stay dumb by construction.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from . import Channel, ChannelCapabilities, OutboundPayload, SendTarget
from .chunk import degrade_markdown, render_choices, split_text

logger = logging.getLogger(__name__)

TYPING_RESEND_SECONDS = 3.0
COMPLETION_REACTION = "✅"
DEFAULT_MAX_TEXT_LENGTH = 4000


class Outbound:
    """Owns the registered channel registry and delivers outbound traffic."""

    def __init__(self, channels: dict[str, Channel]) -> None:
        self._channels = channels

    def register(self, channel: Channel) -> None:
        self._channels[channel.id] = channel

    def capabilities(self, channel_id: str) -> ChannelCapabilities | None:
        channel = self._channels.get(channel_id)
        return getattr(channel, "capabilities", None) if channel is not None else None

    async def send(self, channel_id: str, target: SendTarget, payload: OutboundPayload) -> None:
        channel = self._channels.get(channel_id)
        if channel is None:
            logger.warning("gateway: channel %s has no adapter; dropping outbound payload", channel_id)
            return
        await channel.send(target, payload)

    async def reply(self, position: tuple[str, SendTarget] | None, text: str) -> None:
        if position is not None:
            await self.send(position[0], position[1], OutboundPayload(text=text))

    async def send_question(
        self, position: tuple[str, SendTarget], question_text: str, options: tuple[str, ...]
    ) -> None:
        channel_id, target = position
        capabilities = self.capabilities(channel_id)
        if capabilities is not None and capabilities.supports_buttons:
            payload = OutboundPayload(text=question_text, choices=options)  # native buttons
        else:  # pre-rendered numbered list; channels never format choices
            payload = OutboundPayload(text=f"{question_text}\n\n{render_choices(options)}")
        await self.send(channel_id, target, payload)

    async def send_assistant(self, position: tuple[str, SendTarget], content: str, title: str) -> None:
        """Chunker-split assistant text; first piece carries the task title."""
        channel_id, target = position
        content = content.strip()
        if not content:
            return
        capabilities = self.capabilities(channel_id)
        limit = capabilities.max_text_length if capabilities else DEFAULT_MAX_TEXT_LENGTH
        unit = capabilities.len_unit if capabilities else "chars"
        text = degrade_markdown(content) if capabilities is None or capabilities.markdown == "none" else content
        for index, piece in enumerate(split_text(text, limit, unit)):
            if index == 0 and title:
                piece = f"{title}\n{piece}"
            await self.send(channel_id, target, OutboundPayload(text=piece))

    def start_typing(self, channel_id: str, target: SendTarget, loop: Any) -> Any:
        """Start the 3s typing keepalive; returns the task or None (unsupported)."""
        capabilities = self.capabilities(channel_id)
        channel = self._channels.get(channel_id)
        if capabilities is None or not capabilities.supports_typing or channel is None:
            return None

        async def resend() -> None:
            while True:
                await channel.typing(target)
                await asyncio.sleep(TYPING_RESEND_SECONDS)

        return loop.create_task(resend())

    async def react(self, position: tuple[str, SendTarget] | None) -> None:
        """✅ completion receipt via the optional channel reaction hook."""
        if position is None:
            return
        channel_id, target = position
        channel = self._channels.get(channel_id)
        react = getattr(channel, "react", None)
        supported = getattr(self.capabilities(channel_id), "supports_reaction", False)
        if channel is None or not supported or not callable(react):
            return
        await react(target, COMPLETION_REACTION)


__all__ = ["Outbound"]
