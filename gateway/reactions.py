"""Turn status reactions: one emoji slot per chat position, pump-driven
(openclaw status-reactions.ts pattern).

Lifecycle per turn: queued 👀 → thinking 🧠 → per-tool emoji → terminal
✅ / ❌ / ⏹️.  Intermediate transitions debounce (:data:`DEBOUNCE_SECONDS`)
so rapid tool flips cost at most one reaction edit; terminal states apply
immediately and cancel any pending intermediate.  Stall warnings: ⏳ after
:data:`STALL_WARN_SECONDS` without progress, ⚠️ after :data:`STALE_WARN_SECONDS`
(checked against an injectable clock).  Terminal emoji hold (✅ 1.5s, ❌ 2.5s)
before the slot recycles; transitions arriving during the hold are deferred,
not dropped.  Every reaction edit is serialized per slot and best-effort:
failures log and never raise into the pump, and channels without the
capability are silent no-ops.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

from . import SendTarget

logger = logging.getLogger(__name__)

QUEUED_EMOJI = "👀"
THINKING_EMOJI = "🧠"
STALL_EMOJI = "⏳"
STALE_EMOJI = "⚠️"
TERMINAL_EMOJI = {"turn_completed": "✅", "turn_failed": "❌", "turn_cancelled": "⏹️"}
TOOL_EMOJI: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"bash", "edit", "read", "write"}), "💻"),
    (frozenset({"web_search", "web_fetch"}), "🌐"),
    (frozenset({"delegate"}), "🧵"),
    (frozenset({"plan"}), "📋"),
)
DEFAULT_TOOL_EMOJI = "🛠️"
HOLD_SECONDS = {"✅": 1.5, "❌": 2.5, "⏹️": 1.5}

DEBOUNCE_SECONDS = 0.7
STALL_WARN_SECONDS = 10.0
STALE_WARN_SECONDS = 30.0
STALL_SCAN_SECONDS = 1.0

LIVE_STATES = frozenset({"queued", "thinking", "tool"})
ReactFn = Callable[[tuple[str, SendTarget] | None, str], Awaitable[None]]


def tool_emoji(name: str) -> str:
    """Map a tool name onto its working emoji; unknown tools get 🛠️."""
    key = str(name or "").strip().lower()
    for tools, emoji in TOOL_EMOJI:
        if key in tools:
            return emoji
    return DEFAULT_TOOL_EMOJI


class _Slot:
    """One (channel, chat, thread) emoji slot and its scheduled work."""

    __slots__ = ("position", "state", "emoji", "last_progress", "paused", "lock",
                 "debounce_task", "stall_task", "hold_task", "deferred")

    def __init__(self, position: tuple[str, SendTarget], now: float) -> None:
        self.position = position
        self.state = "idle"  # idle | queued | thinking | tool | terminal | hold
        self.emoji = ""
        self.last_progress = now
        self.paused = False
        self.lock = asyncio.Lock()
        self.debounce_task: asyncio.Task[None] | None = None
        self.stall_task: asyncio.Task[None] | None = None
        self.hold_task: asyncio.Task[None] | None = None
        self.deferred: str | None = None


class ReactionController:
    """Owns the emoji slots; the pump feeds worker events, nothing else."""

    def __init__(self, *, react: ReactFn, clock: Any = time.monotonic,
                 debounce_seconds: float = DEBOUNCE_SECONDS,
                 stall_warn_seconds: float = STALL_WARN_SECONDS,
                 stale_warn_seconds: float = STALE_WARN_SECONDS,
                 stall_scan_seconds: float = STALL_SCAN_SECONDS,
                 hold_seconds: float | None = None) -> None:
        self._react = react
        self._clock = clock
        self._debounce = debounce_seconds
        self._stall_warn = stall_warn_seconds
        self._stale = stale_warn_seconds
        self._stall_scan = stall_scan_seconds
        self._hold_override = hold_seconds  # None → HOLD_SECONDS table
        self._slots: dict[tuple[str, str, str | None], _Slot] = {}

    # --- pump entry points ------------------------------------------------------

    async def on_event(self, position: tuple[str, SendTarget] | None, event: dict,
                       *, replayed: bool = False) -> None:
        slot = self._slot_for(position)
        if slot is None:
            return
        etype = str(event.get("type") or "")
        terminal = TERMINAL_EMOJI.get(etype)
        if replayed and terminal is None:  # catch-up: only terminal receipts matter
            return
        if terminal is not None:
            await self._go_terminal(slot, terminal)
        elif etype == "turn_started":
            if slot.state not in LIVE_STATES and slot.state != "hold":
                # slot goes live here even without a queued phase (e.g. after restart)
                slot.state, slot.last_progress, slot.paused = "thinking", self._clock(), False
                self._ensure_stall_watch(slot)
            self._transition(slot, THINKING_EMOJI)
        elif etype == "user_question_requested":
            slot.last_progress, slot.paused = self._clock(), True
        elif etype in ("tool_requested", "tool_result"):
            slot.last_progress, slot.paused = self._clock(), False
            if etype == "tool_requested":
                self._transition(slot, tool_emoji(str(event.get("tool") or "")))
            else:
                self._transition(slot, THINKING_EMOJI)
        elif etype == "assistant_message_completed":
            slot.last_progress, slot.paused = self._clock(), False

    async def queued(self, position: tuple[str, SendTarget] | None) -> None:
        """Prompt accepted by the worker but not yet confirmed as a turn."""
        slot = self._slot_for(position)
        if slot is None or slot.state in LIVE_STATES:
            return
        slot.state, slot.last_progress, slot.paused = "queued", self._clock(), False
        self._transition(slot, QUEUED_EMOJI)
        self._ensure_stall_watch(slot)

    async def cancel(self, position: tuple[str, SendTarget] | None) -> None:
        """Tear a slot down without a terminal emoji (rolled-back turns)."""
        slot = self._slot_for(position)
        if slot is not None:
            self._teardown_tasks(slot)
            slot.state, slot.emoji, slot.deferred = "idle", "", None

    def check_stalls(self) -> None:
        """Scan live slots against the injectable clock (watch task + tests)."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        now = self._clock()
        for slot in self._slots.values():
            if slot.state not in LIVE_STATES or slot.paused:
                continue
            idle = now - slot.last_progress
            if idle >= self._stale:
                self._warn(slot, STALE_EMOJI)
            elif idle >= self._stall_warn:
                self._warn(slot, STALL_EMOJI)

    async def aclose(self) -> None:
        for slot in self._slots.values():
            self._teardown_tasks(slot)

    # --- transitions ------------------------------------------------------------

    def _slot_for(self, position: tuple[str, SendTarget] | None) -> _Slot | None:
        if position is None:
            return None
        channel_id, target = position
        key = (channel_id, str(target.chat_id), target.thread_id)
        slot = self._slots.get(key)
        if slot is None:
            slot = self._slots[key] = _Slot(position, self._clock())
        return slot

    def _transition(self, slot: _Slot, emoji: str) -> None:
        """Schedule a debounced intermediate emoji (deferred while holding)."""
        if slot.state == "hold":
            slot.deferred = emoji
            return
        if slot.state not in LIVE_STATES or emoji == slot.emoji:
            return
        key = self._key_of(slot)
        task, slot.debounce_task = slot.debounce_task, None
        if task is not None:
            task.cancel()
        slot.debounce_task = asyncio.get_running_loop().create_task(self._debounced(key, emoji))
        self._ensure_stall_watch(slot)

    async def _debounced(self, key: tuple[str, str, str | None], emoji: str) -> None:
        try:
            await asyncio.sleep(self._debounce)
        except asyncio.CancelledError:
            raise
        slot = self._slots.get(key)
        if slot is None or slot.state not in LIVE_STATES:
            return
        await self._apply(slot, emoji)
        if slot.state in LIVE_STATES:
            slot.state = "tool" if emoji not in (QUEUED_EMOJI, THINKING_EMOJI) else "thinking"

    async def _go_terminal(self, slot: _Slot, emoji: str) -> None:
        """Immediate terminal edit, then the hold window before recycling."""
        key = self._key_of(slot)
        for task in (slot.debounce_task, slot.stall_task, slot.hold_task):
            if task is not None:
                task.cancel()
        slot.debounce_task = slot.stall_task = slot.hold_task = None
        slot.paused = False
        slot.state = "terminal"
        await self._apply(slot, emoji)
        slot.state = "hold"
        hold = self._hold_override if self._hold_override is not None else HOLD_SECONDS.get(emoji, 1.5)
        slot.hold_task = asyncio.get_running_loop().create_task(self._hold(key, hold))

    async def _hold(self, key: tuple[str, str, str | None], seconds: float) -> None:
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            raise
        slot = self._slots.get(key)
        if slot is None or slot.state != "hold":
            return
        slot.state = "idle"
        deferred, slot.deferred = slot.deferred, None
        if deferred is not None:  # a new turn started during the hold
            slot.state = "thinking"
            slot.last_progress = self._clock()
            await self._apply(slot, deferred)

    def _warn(self, slot: _Slot, emoji: str) -> None:
        if slot.emoji == emoji:
            return
        task, slot.debounce_task = slot.debounce_task, None  # the warning supersedes pending transitions
        if task is not None:
            task.cancel()
        asyncio.get_running_loop().create_task(self._apply(slot, emoji))

    def _ensure_stall_watch(self, slot: _Slot) -> None:
        if slot.stall_task is None or slot.stall_task.done():
            slot.stall_task = asyncio.get_running_loop().create_task(self._stall_watch(self._key_of(slot)))

    async def _stall_watch(self, key: tuple[str, str, str | None]) -> None:
        try:
            while True:
                await asyncio.sleep(self._stall_scan)
                slot = self._slots.get(key)
                if slot is None or slot.state not in LIVE_STATES:
                    return
                self.check_stalls()
        except asyncio.CancelledError:
            raise

    async def _apply(self, slot: _Slot, emoji: str) -> None:
        """One serialized, best-effort reaction edit per slot."""
        if emoji == slot.emoji:
            return
        async with slot.lock:
            try:
                await self._react(slot.position, emoji)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reactions never break turns
                logger.debug("gateway: reaction %s failed: %s", emoji, exc)
            slot.emoji = emoji

    def _key_of(self, slot: _Slot) -> tuple[str, str, str | None]:
        channel_id, target = slot.position
        return (channel_id, str(target.chat_id), target.thread_id)

    def _teardown_tasks(self, slot: _Slot) -> None:
        for task in (slot.debounce_task, slot.stall_task, slot.hold_task):
            if task is not None:
                task.cancel()
        slot.debounce_task = slot.stall_task = slot.hold_task = None


__all__ = [
    "DEBOUNCE_SECONDS",
    "HOLD_SECONDS",
    "ReactionController",
    "STALL_WARN_SECONDS",
    "STALE_WARN_SECONDS",
    "TERMINAL_EMOJI",
    "tool_emoji",
]
