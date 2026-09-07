"""Unified message gateway: shared types for the core pump and channel adapters.

The gateway is a pure surface over the worker JSONL protocol (dependency rule
D4): only `chunk`/`router`/`security`/`config` stay importable without the
`agent` package, while `worker_client`/`pump` may import protocol constants.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class Attachment:
    """A file already persisted under the workspace uploads/ directory."""

    path: Path
    content_type: str
    kind: str  # "image" | "audio" | "document" | "video"


@dataclass(frozen=True, slots=True)
class InboundMessage:
    """A normalized message from any chat channel."""

    channel: str
    chat_id: str
    chat_type: str  # "dm" | "group"
    sender_id: str
    sender_name: str
    thread_id: str | None
    text: str
    attachments: tuple[Attachment, ...]
    message_ref: str  # channel-native message identity (dedup / replies)


@dataclass(frozen=True, slots=True)
class ChannelCapabilities:
    """Declared per-channel limits; the pump degrades along these."""

    max_text_length: int = 4000
    len_unit: str = "chars"  # "chars" | "utf16"
    supports_typing: bool = False
    supports_buttons: bool = False  # False → pump renders a numbered list
    supports_reaction: bool = False  # False → no ✅ completion receipt
    markdown: str = "none"  # "none" | "subset"


@dataclass(frozen=True, slots=True)
class SendTarget:
    chat_id: str
    thread_id: str | None = None


@dataclass(frozen=True, slots=True)
class OutboundPayload:
    text: str
    attachments: tuple[Attachment, ...] = ()
    choices: tuple[str, ...] = ()  # non-empty → buttons or numbered list


@runtime_checkable
class OutboundSink(Protocol):
    """Where the pump delivers outbound traffic for one channel."""

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None: ...

    async def typing(self, target: SendTarget) -> None: ...


@runtime_checkable
class Channel(Protocol):
    """One chat platform. Inbound flows through pump.inbound(); adapters must
    not contain session, retry, chunking, auth, or persistence logic."""

    id: str
    capabilities: ChannelCapabilities

    async def start(self, sink: OutboundSink) -> None: ...

    async def stop(self) -> None: ...

    async def send(self, target: SendTarget, payload: OutboundPayload) -> None: ...


__all__ = [
    "Attachment",
    "Channel",
    "ChannelCapabilities",
    "InboundMessage",
    "OutboundPayload",
    "OutboundSink",
    "SendTarget",
]
