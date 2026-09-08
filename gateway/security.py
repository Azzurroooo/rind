"""Admission control: DM allowlist + pairing, group mention gating, cooldown.

Decision order per remote-plan/gateway.md §7:
DM → channel allowlist hit? → pairing approved? → pairing.enabled? →
DenyPairing; group → chat in ``group_allow`` AND addressed (@handle) →
Allow, otherwise Deny.  Pairing codes are 6 characters from an alphabet
without I/1/O/0, stored in ``pairing.json`` with a TTL and a pending cap.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from collections import deque
from pathlib import Path
from typing import Callable, Iterable, Mapping

from . import InboundMessage

logger = logging.getLogger(__name__)

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 无歧义：去除 I/1/O/0
CODE_LENGTH = 6
PENDING_CAP = 3
COOLDOWN_WINDOW_SECONDS = 60.0

DEFAULT_BOT_HANDLES = ("rind", "bot")
COOLDOWN_NOTICE = "消息有点频繁，已暂停处理，请稍后再发。"
APPROVE_COMMAND = "python main.py gateway approve {code}"
PAIRING_FULL_NOTICE = "配对申请已达上限，请稍后再试。"


def pairing_notice(channel: str, sender_id: str, code: str, ttl_seconds: float) -> str:
    """Fixed, honest pairing card: identity, code, server command, TTL.

    The command and code alphabet are the server's (gateway.main approve +
    ``CODE_ALPHABET``); the TTL mirrors the configured ``pairing_ttl_seconds``.
    """
    minutes = max(1, int(ttl_seconds // 60))
    return (
        "Rind：尚未授权此账号。\n"
        f"身份：{channel} · {sender_id}\n"
        f"配对码：`{code}`\n"
        f"批准：在服务器执行 `{APPROVE_COMMAND.format(code=code)}`\n"
        f"有效期：{minutes} 分钟，过期后重新发消息会生成新码。"
    )


class Verdict:
    """Outcome of admission; ``notice`` carries the one-line user reply."""

    __slots__ = ("allow", "pairing", "notice")

    def __init__(self, allow: bool, pairing: bool = False, notice: str = "") -> None:
        self.allow = allow
        self.pairing = pairing
        self.notice = notice

    def __repr__(self) -> str:
        return f"Verdict(allow={self.allow}, pairing={self.pairing}, notice={self.notice!r})"


ALLOW = Verdict(True)
DENY = Verdict(False)
DENY_PAIRING = Verdict(False, pairing=True)


class PairingStore:
    """``{"pending": {CODE: {...}}, "approved": [[channel, sender_id], ...]}``."""

    def __init__(self, path: Path, *, now: Callable[[], float] = time.time) -> None:
        self._path = Path(path)
        self._now = now
        self.pending: dict[str, dict[str, object]] = {}
        self.approved: list[list[str]] = []
        self.load()

    def load(self) -> None:
        if not self._path.is_file():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self.pending = {str(code): dict(entry) for code, entry in data.get("pending", {}).items()}
            self.approved = [list(pair) for pair in data.get("approved", [])]
        except (json.JSONDecodeError, OSError, AttributeError):
            corrupt = self._path.parent / (self._path.name + ".corrupt")
            os.replace(self._path, corrupt)
            logger.warning("gateway: pairing store %s was corrupt; renamed to %s and starting empty", self._path, corrupt)
            self.pending = {}
            self.approved = []

    def is_approved(self, channel: str, sender_id: str) -> bool:
        return [channel, sender_id] in self.approved

    def purge_expired(self) -> None:
        now = self._now()
        self.pending = {
            code: entry
            for code, entry in self.pending.items()
            if float(entry.get("expires", 0.0)) > now  # type: ignore[arg-type]
        }

    def ensure_pending(self, channel: str, sender_id: str, ttl_seconds: float) -> str | None:
        """Return an active code for the sender, creating one if needed.

        Purges expired entries first; when the pending cap is reached for a
        brand-new sender, returns ``None``.
        """
        self.purge_expired()
        for code, entry in self.pending.items():
            if entry.get("channel") == channel and entry.get("sender_id") == sender_id:
                return str(code)
        if len(self.pending) >= PENDING_CAP:
            return None
        code = self._generate_code()
        self.pending[code] = {"channel": channel, "sender_id": sender_id, "expires": self._now() + ttl_seconds}
        self.save()
        return code

    def approve(self, code: str) -> dict[str, object] | None:
        """Approve one pending code; returns its {channel, sender_id} entry."""
        self.purge_expired()  # expired codes are dropped, never approvable
        entry = self.pending.pop(code.strip().upper(), None)
        if entry is None:
            return None
        pair = [str(entry.get("channel") or ""), str(entry.get("sender_id") or "")]
        if pair not in self.approved:
            self.approved.append(pair)
        self.save()
        return entry

    def _generate_code(self) -> str:
        return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"pending": self.pending, "approved": self.approved}, ensure_ascii=False, indent=2)
        temp = self._path.with_name(self._path.name + ".tmp")
        temp.write_text(payload, encoding="utf-8")
        os.replace(temp, self._path)


class CooldownGate:
    """Sliding 60s per-(channel, sender) window; first trip gets one notice."""

    def __init__(self, limit: int, *, window_seconds: float = COOLDOWN_WINDOW_SECONDS) -> None:
        self._limit = limit
        self._window = window_seconds
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._notified: set[tuple[str, str]] = set()

    def admit(self, channel: str, sender_id: str, *, now: float | None = None) -> Verdict:
        moment = time.time() if now is None else now
        key = (channel, sender_id)
        window = self._hits.setdefault(key, deque())
        while window and window[0] <= moment - self._window:
            window.popleft()
        # Only admitted messages count toward the window: denied ones must not
        # extend their own denial, or a chatty sender could never recover.
        if len(window) >= self._limit:
            if key not in self._notified:
                self._notified.add(key)
                return Verdict(False, notice=COOLDOWN_NOTICE)
            return DENY
        window.append(moment)
        self._notified.discard(key)
        return ALLOW


def is_addressed_to_bot(message: InboundMessage, handles: Iterable[str] = DEFAULT_BOT_HANDLES) -> bool:
    """Group gating: the normalized text must @mention the bot.

    The §5.2 InboundMessage contract carries no native mention/reply flag, so
    adapters keep the mention text (e.g. "@rind 帮我看看") and gating matches
    ``@<handle>`` tokens case-insensitively; reply-to-bot adapters express the
    same way (WP4).
    """
    normalized = {handle.lower() for handle in handles}
    punctuation = "，。！？,.!?：:\"'（）()[]【】「」『』、;；"
    for token in message.text.split():
        candidate = token.strip(punctuation).lower()
        if candidate.startswith("@") and candidate[1:] in normalized:
            return True
    return False


class SecurityGate:
    """Facade used by the pump: admit(msg) → Allow | DenyPairing | Deny."""

    def __init__(
        self,
        *,
        pairing: PairingStore,
        cooldown: CooldownGate,
        allow_from: Mapping[str, tuple[str, ...]] | None = None,
        group_allow: Mapping[str, tuple[str, ...]] | None = None,
        pairing_enabled: bool = True,
        pairing_ttl_seconds: float = 3600.0,
        bot_handles: Iterable[str] = DEFAULT_BOT_HANDLES,
    ) -> None:
        self._pairing = pairing
        self._cooldown = cooldown
        self._allow_from = dict(allow_from or {})
        self._group_allow = dict(group_allow or {})
        self._pairing_enabled = pairing_enabled
        self._pairing_ttl = pairing_ttl_seconds
        self._bot_handles = tuple(bot_handles)

    def admit(self, message: InboundMessage) -> Verdict:
        verdict = self._admit_by_source(message)
        if not verdict.allow:
            return verdict
        # Cooldown applies only to otherwise-admitted senders (§5 row 3);
        # pairing/group denials must not consume a sender's message budget.
        return self._cooldown.admit(message.channel, message.sender_id)

    def _admit_by_source(self, message: InboundMessage) -> Verdict:
        if message.chat_type != "group":
            return self._admit_dm(message)
        if message.chat_id in self._group_allow.get(message.channel, ()):
            if is_addressed_to_bot(message, self._bot_handles):
                return ALLOW
        return DENY

    def _admit_dm(self, message: InboundMessage) -> Verdict:
        if message.sender_id in self._allow_from.get(message.channel, ()):
            return ALLOW
        if self._pairing.is_approved(message.channel, message.sender_id):
            return ALLOW
        if not self._pairing_enabled:
            return DENY
        code = self._pairing.ensure_pending(message.channel, message.sender_id, self._pairing_ttl)
        if code is None:
            return Verdict(False, pairing=True, notice=PAIRING_FULL_NOTICE)
        return Verdict(False, pairing=True,
                       notice=pairing_notice(message.channel, message.sender_id, code, self._pairing_ttl))


__all__ = [
    "ALLOW",
    "CODE_ALPHABET",
    "CooldownGate",
    "DENY",
    "DENY_PAIRING",
    "PENDING_CAP",
    "PairingStore",
    "SecurityGate",
    "Verdict",
    "is_addressed_to_bot",
    "pairing_notice",
]
