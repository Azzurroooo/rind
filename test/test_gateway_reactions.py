"""ReactionController state-machine tests (status-reactions pattern).

Covers the full lifecycle (queued 👀 → thinking 🧠 → tool emoji → terminal),
debounce suppression with real (shrunk) timers, immediate terminals, terminal
hold with deferred transitions, stall warnings against an injectable clock,
question pause, serialization of reaction API calls, replay filtering, and
best-effort tolerance of failing react hooks.  Sync tests over asyncio.run.
"""

import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import SendTarget  # noqa: E402
from gateway.reactions import (  # noqa: E402
    QUEUED_EMOJI,
    STALE_EMOJI,
    STALL_EMOJI,
    THINKING_EMOJI,
    ReactionController,
    tool_emoji,
)

POSITION = ("test", SendTarget(chat_id="c1"))


class _Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class _Recorder:
    """React hook recording every applied emoji (optionally slow/failing)."""

    def __init__(self, delay=0.0, error=None):
        self.emoji: list[str] = []
        self.delay = delay
        self.error = error
        self.concurrent = 0
        self.max_concurrent = 0

    async def __call__(self, position, emoji):
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.error is not None:
                raise self.error
            self.emoji.append(emoji)
        finally:
            self.concurrent -= 1


def _controller(recorder, clock=None, **overrides):
    kwargs = dict(debounce_seconds=0.02, stall_warn_seconds=10.0, stale_warn_seconds=30.0,
                  stall_scan_seconds=1000.0)  # watch effectively off; tests drive check_stalls
    kwargs.update(overrides)
    return ReactionController(react=recorder, clock=clock or _Clock(), **kwargs)


async def _settle(seconds=0.06):
    await asyncio.sleep(seconds)


# --- tool emoji mapping ---------------------------------------------------------


def test_tool_emoji_mapping():
    assert tool_emoji("bash") == "💻" and tool_emoji("edit") == "💻"
    assert tool_emoji("read") == "💻" and tool_emoji("write") == "💻"
    assert tool_emoji("web_search") == "🌐" and tool_emoji("web_fetch") == "🌐"
    assert tool_emoji("delegate") == "🧵" and tool_emoji("plan") == "📋"
    assert tool_emoji("unknown_tool") == "🛠️" and tool_emoji("") == "🛠️"


# --- lifecycle -------------------------------------------------------------------


def test_lifecycle_queued_thinking_tool_then_terminal_immediate():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.queued(POSITION)
        await _settle()  # debounce window passes → 👀 applied
        assert recorder.emoji == [QUEUED_EMOJI]
        await controller.on_event(POSITION, {"type": "turn_started"})
        await _settle()
        assert recorder.emoji == [QUEUED_EMOJI, THINKING_EMOJI]
        await controller.on_event(POSITION, {"type": "tool_requested", "tool": "bash"})
        await _settle()
        assert recorder.emoji[-1] == "💻"
        await controller.on_event(POSITION, {"type": "turn_completed"})  # immediate, no debounce
        assert recorder.emoji[-1] == "✅"
        await _settle(0.1)  # past the ✅ hold: nothing else fires
        assert recorder.emoji == [QUEUED_EMOJI, THINKING_EMOJI, "💻", "✅"]
        await controller.aclose()

    asyncio.run(scenario())


def test_rapid_intermediates_debounce_to_last_one():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.on_event(POSITION, {"type": "turn_started"})
        await controller.on_event(POSITION, {"type": "tool_requested", "tool": "bash"})
        await controller.on_event(POSITION, {"type": "tool_requested", "tool": "web_search"})
        await _settle()
        assert recorder.emoji == ["🌐"]  # 🧠 and 💻 never made it past the debounce
        await controller.aclose()

    asyncio.run(scenario())


def test_terminal_cancels_pending_intermediate():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.on_event(POSITION, {"type": "turn_started"})
        await controller.on_event(POSITION, {"type": "turn_failed"})  # before 🧠 debounces
        assert recorder.emoji == ["❌"]
        await _settle(0.1)  # past the ❌ hold
        assert recorder.emoji == ["❌"]
        await controller.aclose()

    asyncio.run(scenario())


def test_terminal_hold_defers_new_turn_transition():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder, hold_seconds=0.2)
        await controller.on_event(POSITION, {"type": "turn_completed"})
        assert recorder.emoji == ["✅"]
        await controller.on_event(POSITION, {"type": "turn_started"})  # inside the hold window
        await _settle()  # 0.06s < hold: receipt stays untouched
        assert recorder.emoji == ["✅"]  # hold keeps the receipt visible
        await _settle(0.25)  # hold expires → deferred 🧠 lands
        assert recorder.emoji == ["✅", THINKING_EMOJI]
        await controller.aclose()

    asyncio.run(scenario())


def test_cancel_clears_slot_without_touching_the_channel():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.queued(POSITION)
        await controller.cancel(POSITION)
        assert recorder.emoji == []  # rolled-back turn leaves no reaction behind
        await controller.queued(POSITION)  # slot is reusable
        await _settle()
        assert recorder.emoji == [QUEUED_EMOJI]
        await controller.aclose()

    asyncio.run(scenario())


# --- stall warnings (injectable clock) --------------------------------------------


def test_stall_warnings_fire_at_10s_and_30s_without_progress():
    async def scenario():
        clock = _Clock()
        recorder = _Recorder()
        controller = _controller(recorder, clock=clock)
        await controller.queued(POSITION)
        clock.advance(11)
        controller.check_stalls()
        await _settle(0.01)
        assert recorder.emoji == [STALL_EMOJI]  # ⏳ at 10s
        clock.advance(20)  # 31s since progress
        controller.check_stalls()
        await _settle(0.01)
        assert recorder.emoji == [STALL_EMOJI, STALE_EMOJI]  # ⚠️ at 30s
        await controller.aclose()

    asyncio.run(scenario())


def test_progress_and_terminal_reset_stall_tracking():
    async def scenario():
        clock = _Clock()
        recorder = _Recorder()
        controller = _controller(recorder, clock=clock)
        await controller.on_event(POSITION, {"type": "turn_started"})
        await _settle()
        assert recorder.emoji == [THINKING_EMOJI]
        await controller.on_event(POSITION, {"type": "tool_requested", "tool": "read"})
        clock.advance(9)
        controller.check_stalls()  # 9s since the tool started: inside the 10s window
        await _settle()  # the 💻 debounce lands
        assert recorder.emoji == [THINKING_EMOJI, "💻"]
        await controller.on_event(POSITION, {"type": "tool_result", "tool": "read"})  # progress
        clock.advance(9)  # 18s since tool_requested, but only 9s since tool_result
        controller.check_stalls()
        await _settle(0.01)
        assert STALL_EMOJI not in recorder.emoji  # tool_result reset the stall clock
        await controller.on_event(POSITION, {"type": "turn_completed"})
        clock.advance(60)
        controller.check_stalls()  # terminal slots never warn
        await _settle(0.01)
        assert recorder.emoji == [THINKING_EMOJI, "💻", "✅"]
        await controller.aclose()

    asyncio.run(scenario())


def test_pending_question_pauses_stall_warnings():
    async def scenario():
        clock = _Clock()
        recorder = _Recorder()
        controller = _controller(recorder, clock=clock)
        await controller.on_event(POSITION, {"type": "turn_started"})
        await _settle()  # let 🧠 land so a stall would visibly replace it
        await controller.on_event(POSITION, {"type": "user_question_requested"})
        clock.advance(60)
        controller.check_stalls()
        await _settle(0.01)
        assert recorder.emoji == [THINKING_EMOJI]  # waiting on the human is not a stall
        await controller.aclose()

    asyncio.run(scenario())


# --- tolerance and serialization ----------------------------------------------------


def test_failing_react_hook_never_raises_into_the_pump():
    async def scenario():
        recorder = _Recorder(error=RuntimeError("reaction API down"))
        controller = _controller(recorder)
        await controller.queued(POSITION)
        await controller.on_event(POSITION, {"type": "turn_completed"})  # must not raise
        await controller.aclose()

    asyncio.run(scenario())


def test_reaction_api_calls_are_serialized_per_slot():
    async def scenario():
        recorder = _Recorder(delay=0.05)
        controller = _controller(recorder)
        await controller.on_event(POSITION, {"type": "turn_started"})
        await _settle()  # 🧠 applied (slow)
        await controller.on_event(POSITION, {"type": "tool_requested", "tool": "bash"})
        await _settle(0.03)  # 💻 debounce fires while 🧠 may still hold the lock
        await controller.on_event(POSITION, {"type": "turn_completed"})  # immediate ✅
        await _settle(0.2)
        assert recorder.max_concurrent == 1  # never two edits at once
        assert recorder.emoji[-1] == "✅"  # terminal wins the slot
        await controller.aclose()

    asyncio.run(scenario())


def test_replayed_intermediates_ignored_but_terminal_receipt_applies():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.on_event(POSITION, {"type": "turn_started"}, replayed=True)
        await controller.on_event(POSITION, {"type": "tool_requested", "tool": "read"}, replayed=True)
        await _settle()
        assert recorder.emoji == []  # catch-up never fakes progress
        await controller.on_event(POSITION, {"type": "turn_completed"}, replayed=True)
        assert recorder.emoji == ["✅"]  # the receipt survives reconnects
        await controller.aclose()

    asyncio.run(scenario())


def test_events_without_position_are_ignored():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.queued(None)
        await controller.on_event(None, {"type": "turn_completed"})
        await _settle()
        assert recorder.emoji == []
        await controller.aclose()

    asyncio.run(scenario())


def test_terminal_without_prior_state_still_receives_receipt():
    async def scenario():
        recorder = _Recorder()
        controller = _controller(recorder)
        await controller.on_event(POSITION, {"type": "turn_completed"})  # idle slot: legacy ✅ path
        assert recorder.emoji == ["✅"]
        await controller.aclose()

    asyncio.run(scenario())
