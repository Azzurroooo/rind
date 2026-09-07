"""Outbound typing lifecycle + reaction hook tests (openclaw typing.ts hardening).

Covers: 3s keepalive restart semantics, the 2-consecutive-failure tripwire
(stop attempting for the turn, log once), the 60s hard TTL (auto-stop even
with the turn still running), serialized stop-after-start ordering, and the
capability-gated react hook used by the reaction controller.  Timings are
shrunk via module constants, following the pump-test monkeypatch convention.
"""

import asyncio
import contextlib
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import ChannelCapabilities, OutboundPayload, SendTarget  # noqa: E402
import gateway.outbound as outbound_module  # noqa: E402
from gateway.outbound import Outbound  # noqa: E402

POSITION = ("test", SendTarget(chat_id="c1"))


class _TypingChannel:
    id = "test"

    def __init__(self, capabilities=None, *, fail=False, delay=0.0):
        self.capabilities = capabilities or ChannelCapabilities(supports_typing=True)
        self.fail = fail
        self.delay = delay
        self.calls: list[str] = []  # "start"/"end" markers per typing attempt
        self.reactions: list[tuple[str, str]] = []

    async def start(self, sink):
        self.sink = sink

    async def stop(self):
        pass

    async def send(self, target, payload):
        pass

    async def typing(self, target):
        self.calls.append("start")
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.fail:
                raise RuntimeError("send_chat_action exploded")
            self.calls.append("end")
        except asyncio.CancelledError:
            self.calls.append("cancelled")
            raise

    async def react(self, target, emoji):
        self.reactions.append((target.chat_id, emoji))


@pytest.fixture
def fast_typing(monkeypatch):
    monkeypatch.setattr(outbound_module, "TYPING_RESEND_SECONDS", 0.01)
    return None


async def _until(predicate, timeout=2.0, message="condition not met"):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError(message)
        await asyncio.sleep(0.005)


# --- typing keepalive ---------------------------------------------------------------


def test_typing_resends_until_stop_and_stops_for_good(fast_typing):
    async def scenario():
        channel = _TypingChannel()
        out = Outbound({"test": channel})
        loop = asyncio.get_running_loop()
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
        await _until(lambda: len(channel.calls) >= 6)  # immediate + resends
        await out.stop_typing("k1")
        settled = len(channel.calls)
        await asyncio.sleep(0.05)
        assert len(channel.calls) == settled  # no keepalive after the stop
        await out.stop_typing("k1")  # idempotent
        assert len(channel.calls) == settled

    asyncio.run(scenario())


def test_typing_tripwire_stops_after_two_consecutive_failures(fast_typing, caplog):
    async def scenario():
        channel = _TypingChannel(fail=True)
        out = Outbound({"test": channel})
        loop = asyncio.get_running_loop()
        with caplog.at_level("WARNING", logger="gateway.outbound"):
            out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
            task = out._typing["k1"]
            await _until(lambda: task.done(), message="tripwire never stopped the keepalive")
            assert channel.calls.count("start") == 2  # 2 failures → stop attempting
            await asyncio.sleep(0.05)
            assert channel.calls.count("start") == 2
            warnings = [record for record in caplog.records if "typing failed" in record.getMessage()]
            assert len(warnings) == 1  # logged exactly once per turn
        await out.stop_typing("k1")

    asyncio.run(scenario())


def test_typing_success_resets_the_failure_counter(fast_typing):
    async def scenario():
        channel = _TypingChannel()
        out = Outbound({"test": channel})
        state = {"fail_next": 1}

        async def flaky(target):
            channel.calls.append("start")
            if state["fail_next"] > 0:
                state["fail_next"] -= 1
                raise RuntimeError("once")
            channel.calls.append("end")

        channel.typing = flaky
        loop = asyncio.get_running_loop()
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
        await _until(lambda: len(channel.calls) >= 6)  # keepalive survived the single failure
        await out.stop_typing("k1")

    asyncio.run(scenario())


def test_typing_hard_ttl_stops_keepalive_mid_turn(monkeypatch):
    monkeypatch.setattr(outbound_module, "TYPING_RESEND_SECONDS", 0.01)
    monkeypatch.setattr(outbound_module, "TYPING_TTL_SECONDS", 0.05)

    async def scenario():
        channel = _TypingChannel()
        out = Outbound({"test": channel})
        loop = asyncio.get_running_loop()
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
        task = out._typing["k1"]
        await _until(lambda: task.done(), message="keepalive outlived the hard TTL")
        count = len(channel.calls)
        assert count >= 2  # it did type for a while first
        await asyncio.sleep(0.05)
        assert len(channel.calls) == count  # auto-stopped even though the turn still runs
        await out.stop_typing("k1")

    asyncio.run(scenario())


def test_stop_typing_lands_after_any_in_flight_start(fast_typing):
    async def scenario():
        channel = _TypingChannel(delay=0.05)
        out = Outbound({"test": channel})
        loop = asyncio.get_running_loop()
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
        await asyncio.sleep(0.01)  # a typing attempt is in flight now
        await out.stop_typing("k1")  # must await the in-flight attempt's full unwind
        channel.calls.append("STOP")
        sequence = channel.calls
        assert sequence == ["start", "cancelled", "STOP"]  # stop followed the unwound start
        await asyncio.sleep(0.03)
        assert channel.calls == sequence  # and no further attempts happen

    asyncio.run(scenario())


def test_typing_unsupported_channel_never_schedules(fast_typing):
    async def scenario():
        channel = _TypingChannel(ChannelCapabilities(supports_typing=False))
        out = Outbound({"test": channel})
        loop = asyncio.get_running_loop()
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
        out.start_typing("k1", "missing", SendTarget(chat_id="c1"), loop)
        await asyncio.sleep(0.05)
        assert channel.calls == [] and out._typing == {}

    asyncio.run(scenario())


def test_start_typing_replaces_the_previous_turn_task(fast_typing):
    async def scenario():
        channel = _TypingChannel()
        out = Outbound({"test": channel})
        loop = asyncio.get_running_loop()
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)
        first = out._typing["k1"]
        out.start_typing("k1", "test", SendTarget(chat_id="c1"), loop)  # e.g. turn restart
        second = out._typing["k1"]
        assert first is not second
        with contextlib.suppress(asyncio.CancelledError):
            await first  # previous task is fully cancelled, not leaked
        assert first.cancelled() and not second.done()
        await out.stop_typing("k1")

    asyncio.run(scenario())


# --- reaction hook --------------------------------------------------------------------


def test_react_emoji_goes_through_capable_adapters():
    async def scenario():
        channel = _TypingChannel(ChannelCapabilities(supports_reaction=True))
        out = Outbound({"test": channel})
        await out.react_emoji(POSITION, "👀")
        await out.react(POSITION)  # legacy ✅ receipt
        assert channel.reactions == [("c1", "👀"), ("c1", "✅")]

    asyncio.run(scenario())


def test_react_emoji_is_silent_noop_without_capability_or_adapter():
    async def scenario():
        plain = _TypingChannel(ChannelCapabilities())  # supports_reaction defaults False
        out = Outbound({"test": plain})
        await out.react_emoji(POSITION, "✅")  # capability off
        await out.react_emoji(None, "✅")  # no position
        await out.react_emoji(("ghost", SendTarget(chat_id="c1")), "✅")  # no adapter
        assert plain.reactions == []
        reactless = _TypingChannel(ChannelCapabilities(supports_reaction=True))
        reactless.react = None  # capability says yes, adapter lacks the hook
        out2 = Outbound({"test": reactless})
        await out2.react_emoji(POSITION, "✅")
        assert reactless.reactions == []

    asyncio.run(scenario())


def test_send_delivers_payload_through_the_registry():
    async def scenario():
        recorded = []

        class _SendChannel(_TypingChannel):
            async def send(self, target, payload):
                recorded.append((target.chat_id, payload.text))

        out = Outbound({"test": _SendChannel()})
        await out.send("test", SendTarget(chat_id="c1"), OutboundPayload(text="你好"))
        await out.reply(POSITION, "一条回复")
        await out.reply(None, "无位置")  # dropped quietly
        await out.send("missing", SendTarget(chat_id="c1"), OutboundPayload(text="丢弃"))
        assert recorded == [("c1", "你好"), ("c1", "一条回复")]

    asyncio.run(scenario())
