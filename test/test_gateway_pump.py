"""TurnPump decision-table tests, driven in-process through fake_worker.

Every inbound row (gateway.md §5) gets at least one test, plus the event→
outbound mapping, WorkerTimeout handling, question expiry (injectable
deadlines), stuck-turn reset, offline queueing and cursor tracking.  The
harness wires a real WorkerClient to a FakeWorker over an in-memory
transport, so tests exercise the full request/event plumbing.
"""

import asyncio
import contextlib
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget
from gateway.fake_worker import FakeWorker
from gateway.pump import TurnPump
from gateway.router import SessionRouter
from gateway.security import CooldownGate, PairingStore, SecurityGate
from gateway.worker_client import WorkerClient, WorkerConnectionError

REQUEST_TIMEOUT = 5.0


class _MemTransport:
    """Bridges WorkerClient to a FakeWorker connection, in-process."""

    def __init__(self, worker):
        self._worker = worker
        self._connection = None

    async def open(self):
        self._connection = self._worker.open_connection()

    async def read(self):
        return await self._connection.recv()

    async def write(self, payload):
        self._connection.receive(payload)

    async def close(self):
        self._connection = None


class _Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class _ChannelStub:
    id = "test"

    def __init__(self, capabilities=None):
        self.capabilities = capabilities or ChannelCapabilities()
        self.sent = []
        self.typings = 0
        self.reactions = []

    async def start(self, sink):
        self.sink = sink

    async def stop(self):
        pass

    async def send(self, target, payload):
        self.sent.append(payload)

    async def typing(self, target):
        self.typings += 1

    async def react(self, target, emoji):
        self.reactions.append(emoji)


async def _until(predicate, timeout=2.0, message="condition not met"):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(message)
        await asyncio.sleep(0.005)


def _message(ref, text="做件事", **overrides):
    base = dict(channel="test", chat_id="chat", chat_type="dm", sender_id="u1", sender_name="n",
                thread_id=None, text=text, attachments=(), message_ref=ref)
    base.update(overrides)
    return InboundMessage(**base)


def _security(tmp_path, clock, *, cooldown_limit=1000, pairing_enabled=False, allow=("u1",)):
    return SecurityGate(
        pairing=PairingStore(tmp_path / "pairing.json", now=clock),
        cooldown=CooldownGate(cooldown_limit),
        allow_from={"test": tuple(allow)},
        group_allow={"test": ("good-group",)},
        pairing_enabled=pairing_enabled,
        pairing_ttl_seconds=3600.0,
    )


async def _harness(tmp_path, clock, *, security=None, capabilities=None, stall=()):
    worker = FakeWorker(stall_methods=stall)
    client = WorkerClient("in-memory", None, transport=_MemTransport(worker))
    router = SessionRouter(tmp_path / "state.json")
    security = security or _security(tmp_path, clock)
    channel = _ChannelStub(capabilities)
    pump = TurnPump(worker=client, router=router, security=security, workspace_root="/ws",
                    clock=clock, question_ttl=300.0, scan_interval=30.0, request_timeout=REQUEST_TIMEOUT)
    pump.register_channel(channel)
    await client.start()
    return SimpleNamespace(worker=worker, client=client, router=router, pump=pump, channel=channel)


async def _teardown(harness, *tasks):
    await harness.client.stop()  # fails pending futures; pump answers instead of hanging
    for task in tasks:
        if task is not None and not task.done():
            task.cancel()
    await asyncio.gather(*(t for t in tasks if t is not None), return_exceptions=True)


async def _start_turn(harness, ref="m-1", text="帮我做一件事"):
    """Deliver an inbound message; returns (prompt_task, session_id)."""
    task = asyncio.create_task(harness.pump.inbound(_message(ref, text)))
    await _until(lambda: harness.worker.prompts, message="prompt never reached worker")
    return task, harness.worker.prompts[0][0]


def _texts(channel):
    return [payload.text for payload in channel.sent]


# --- inbound row 1: message_ref LRU dedup -------------------------------------

def test_row1_duplicate_message_ref_is_dropped(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task = asyncio.create_task(harness.pump.inbound(_message("m-1")))
        await _until(lambda: len(harness.worker.prompts) == 1)
        await harness.pump.inbound(_message("m-1"))  # same ref → dropped
        assert len(harness.worker.prompts) == 1
        harness.worker.push_event(harness.worker.prompts[0][0], {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


# --- inbound row 2: deny_pairing → pairing instructions ------------------------

def test_row2_unpaired_dm_gets_pairing_code_and_no_session(tmp_path):
    async def scenario(tmp_path):
        clock = _Clock()
        harness = await _harness(tmp_path, clock,
                                 security=_security(tmp_path, clock, allow=(), pairing_enabled=True))
        await harness.pump.inbound(_message("m-1"))
        texts = _texts(harness.channel)
        assert len(texts) == 1 and "approve" in texts[0]
        assert harness.worker.created == []  # no session/new for unpaired senders
        code = next(iter(harness.pump._security._pairing.pending))
        assert code in texts[0]
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


# --- inbound row 3: silent deny + first cooldown notice ------------------------

def test_row3_group_not_allowlisted_is_silently_dropped(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", chat_type="group", chat_id="evil", text="@rind 你好"))
        assert harness.channel.sent == [] and harness.worker.created == []
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


def test_row3_group_allowlisted_needs_mention(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", chat_type="group", chat_id="good-group", text="闲聊"))
        assert harness.channel.sent == [] and harness.worker.created == []
        task = asyncio.create_task(harness.pump.inbound(
            _message("m-2", chat_type="group", chat_id="good-group", text="@rind 帮忙")))
        await _until(lambda: len(harness.worker.prompts) == 1)
        harness.worker.push_event(harness.worker.prompts[0][0], {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_row3_cooldown_first_trip_notices_then_silent(tmp_path):
    async def scenario(tmp_path):
        clock = _Clock()
        harness = await _harness(tmp_path, clock, security=_security(tmp_path, clock, cooldown_limit=1))
        task = asyncio.create_task(harness.pump.inbound(_message("m-1")))
        await _until(lambda: len(harness.worker.prompts) == 1)
        await harness.pump.inbound(_message("m-2"))  # trips the 1-per-window cooldown
        assert any("频繁" in text for text in _texts(harness.channel))
        await harness.pump.inbound(_message("m-3"))  # still denied, but silent now
        frequent = [text for text in _texts(harness.channel) if "频繁" in text]
        assert len(frequent) == 1
        assert len(harness.worker.prompts) == 1  # denied messages never reach the worker
        harness.worker.push_event(harness.worker.prompts[0][0], {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


# --- inbound row 4: /stop cancels the active turn ------------------------------

def test_row4_stop_cancels_active_turn(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        await harness.pump.inbound(_message("m-2", text="/stop"))
        assert harness.worker.cancels == [session_id]
        await _until(lambda: any("已停止" in text for text in _texts(harness.channel)))
        await _until(task.done)
        assert harness.pump._turns == {}
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_row4_stop_without_active_turn_is_ignored(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/stop"))
        assert harness.worker.cancels == [] and harness.worker.prompts == []
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


# --- inbound row 5: pending question digits ------------------------------------

def _question_event(options=("甲", "乙")):
    return {"type": "user_question_requested", "question": "选一个：", "tool_call_id": "q-1",
            "options": [{"label": label} for label in options]}


def test_row5_digit_answers_pending_question(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, _question_event())
        await _until(lambda: any("1. 甲" in text for text in _texts(harness.channel)))
        await harness.pump.inbound(_message("m-2", text="2"))
        assert harness.worker.answers == [(session_id, "q-1", "乙")]
        assert harness.pump._questions == {}  # question is terminal once answered
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_row5_expired_question_digits_fall_through(tmp_path):
    async def scenario(tmp_path):
        clock = _Clock()
        harness = await _harness(tmp_path, clock)
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, _question_event())
        await _until(lambda: harness.pump._questions != {})
        clock.advance(301)  # past the 300s deadline: digits no longer answer it
        await harness.pump.inbound(_message("m-2", text="1"))
        assert harness.worker.answers == []
        assert harness.worker.follow_ups == [(session_id, "1")]  # active turn → follow_up
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


# --- inbound rows 6/7: follow_up vs prompt --------------------------------------

def test_row6_active_turn_text_becomes_follow_up(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "turn_started"})
        await harness.pump.inbound(_message("m-2", text="追加要求"))
        assert harness.worker.follow_ups == [(session_id, "追加要求")]
        assert len(harness.worker.prompts) == 1  # no second prompt
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_row7_new_conversation_creates_session_and_prompt(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness, text="第一件事")
        assert harness.worker.created and harness.worker.created[0]["workspace_root"] == "/ws"
        assert harness.router.lookup("test:dm:chat").session_id == session_id
        assert harness.worker.prompts == [(session_id, "第一件事")]
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        assert harness.pump._turns == {}  # terminal event resets the turn
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_session_create_failure_replies_one_line(tmp_path):
    async def scenario(tmp_path):
        class _DownWorker:
            connected = True

            def on_event(self, callback):
                pass

            async def subscribe(self, session_id):
                pass

            async def request(self, method, params, timeout=None):
                raise WorkerConnectionError("worker down")

        harness = await _harness(tmp_path, _Clock())
        await harness.client.stop()
        harness.pump._worker = _DownWorker()
        await harness.pump.inbound(_message("m-1"))
        assert _texts(harness.channel) == ["暂时无法创建会话，稍后再试"]
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


# --- WorkerTimeout / stuck turns / offline queueing ------------------------------

def test_worker_timeout_replies_without_crashing(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock(), stall=("session/prompt",))
        harness.pump._request_timeout = 0.05
        task = asyncio.create_task(harness.pump.inbound(_message("m-1")))
        await _until(lambda: _texts(harness.channel) == ["worker 暂时无响应，已重试排队"])
        await asyncio.wait_for(task, 2)
        assert harness.pump._turns == {}  # unconfirmed turn is rolled back
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_stuck_turn_is_reset_after_30_minutes(tmp_path):
    async def scenario(tmp_path):
        clock = _Clock()
        harness = await _harness(tmp_path, clock)
        task, _ = await _start_turn(harness)
        clock.advance(31 * 60)
        await harness.pump._reset_stuck_turns()
        assert harness.pump._turns == {}
        second = asyncio.create_task(harness.pump.inbound(_message("m-2", text="再来一件事")))
        await _until(lambda: len(harness.worker.prompts) == 2)  # new prompt, not a follow_up
        harness.worker.push_event(harness.worker.prompts[1][0], {"type": "turn_completed"})
        await _until(second.done)
        await _teardown(harness, task, second)  # first prompt stays pending; teardown unblocks it

    asyncio.run(scenario(tmp_path))


def test_offline_messages_queue_with_cap_and_flush_in_order(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())

        class _StubWorker:
            def __init__(self):
                self.connected = False
                self.requests = []
                self._callback = None
                self._sequence = 0

            def on_event(self, callback):
                self._callback = callback

            async def subscribe(self, session_id):
                pass

            async def request(self, method, params, timeout=None):
                if not self.connected:
                    raise WorkerConnectionError("worker offline")
                self.requests.append((method, dict(params)))
                if method == "session/prompt":  # completes each turn immediately
                    self._sequence += 1
                    envelope = {"kind": "event", "method": "session/update", "sequence": self._sequence,
                                "durability": "durable", "session_id": "s-1", "turn_id": "t",
                                "event": {"type": "turn_completed"}}
                    await self._callback(envelope, False)
                return {"session_id": "s-1", "ok": True}

        stub = _StubWorker()
        pump = harness.pump
        pump._worker = stub  # worker "offline": messages must queue, not process
        stub.on_event(pump.handle_event)
        for index in range(120):  # cap is 100: oldest 20 dropped
            await pump.inbound(_message(f"q-{index}", text=f"q-{index}"))
        assert len(pump._pending_inbound) == 100
        assert pump._pending_inbound[0].message_ref == "q-20"
        assert stub.requests == [] and harness.worker.created == []

        stub.connected = True
        await pump.inbound(_message("q-120", text="q-120"))  # triggers the ordered flush first
        prompts = [params["input"] for method, params in stub.requests if method == "session/prompt"]
        assert prompts == [f"q-{index}" for index in range(20, 121)]
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


# --- question expiry scan ---------------------------------------------------------

def test_question_expiry_without_timeout_option_notifies_user(tmp_path):
    async def scenario(tmp_path):
        clock = _Clock()
        harness = await _harness(tmp_path, clock)
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, _question_event())
        await _until(lambda: harness.pump._questions != {})
        clock.advance(301)
        await harness.pump._expire_questions()
        assert harness.worker.answers == []
        assert _texts(harness.channel)[-1] == "问题已超时"
        assert harness.pump._questions == {}
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_question_expiry_answers_the_timeout_option(tmp_path):
    async def scenario(tmp_path):
        clock = _Clock()
        harness = await _harness(tmp_path, clock)
        task, session_id = await _start_turn(harness)
        event = _question_event(options=("继续等", "超时退出"))
        harness.worker.push_event(session_id, event)
        await _until(lambda: harness.pump._questions != {})
        clock.advance(301)
        await harness.pump._expire_questions()
        assert harness.worker.answers == [(session_id, "q-1", "超时退出")]
        assert not any("问题已超时" in text for text in _texts(harness.channel))
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


# --- events → outbound mapping -----------------------------------------------------

def test_turn_started_sends_typing_and_resends_every_3s(tmp_path, monkeypatch):
    import gateway.outbound as outbound_module
    monkeypatch.setattr(outbound_module, "TYPING_RESEND_SECONDS", 0.02)

    async def scenario(tmp_path):
        capabilities = ChannelCapabilities(supports_typing=True)
        harness = await _harness(tmp_path, _Clock(), capabilities=capabilities)
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "turn_started"})
        await _until(lambda: harness.channel.typings >= 3)  # immediate + 2 resends
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        settled = harness.channel.typings
        await asyncio.sleep(0.08)  # typing task must be cancelled by the terminal event
        assert harness.channel.typings == settled
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_turn_started_without_typing_support_sends_nothing(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "turn_started"})
        await asyncio.sleep(0.05)
        assert harness.channel.typings == 0
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_user_question_renders_numbered_list_without_buttons(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, _question_event(("甲", "乙", "丙")))
        await _until(lambda: len(_texts(harness.channel)) == 1)
        lines = _texts(harness.channel)[0].splitlines()
        assert lines[0] == "选一个：" and "1. 甲" in lines and "回复数字即可" in lines
        question = next(iter(harness.pump._questions.values()))
        assert question.deadline == pytest.approx(1000.0 + 300.0)  # injectable clock + 300s TTL
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_user_question_uses_native_buttons_when_supported(tmp_path):
    async def scenario(tmp_path):
        capabilities = ChannelCapabilities(supports_buttons=True)
        harness = await _harness(tmp_path, _Clock(), capabilities=capabilities)
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, _question_event(("甲", "乙")))
        await _until(lambda: len(harness.channel.sent) == 1)
        payload = harness.channel.sent[0]
        assert payload.choices == ("甲", "乙") and payload.text == "选一个："
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_assistant_message_chunked_with_title_prefix(tmp_path):
    async def scenario(tmp_path):
        capabilities = ChannelCapabilities(max_text_length=300)  # cap 100 after reserve
        harness = await _harness(tmp_path, _Clock(), capabilities=capabilities)
        task, session_id = await _start_turn(harness, text="修复任务\n请执行")
        body = "啊" * 250
        harness.worker.push_event(session_id, {"type": "assistant_message_completed", "content": body})
        harness.worker.push_event(session_id, {"type": "turn_completed"})  # settles all sends
        await _until(task.done)
        pieces = [payload.text for payload in harness.channel.sent]
        assert len(pieces) == 3  # 250 codepoints → 100 + 100 + 50 under cap 100
        assert pieces[0] == "修复任务\n" + "啊" * 100  # first piece carries the task title
        assert "".join(pieces) == "修复任务\n" + body
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_assistant_message_degrades_markdown_for_plain_channels(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())  # default capabilities: markdown "none"
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(
            session_id, {"type": "assistant_message_completed", "content": "**重点** 和 [链接](https://x.y)"})
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        text = _texts(harness.channel)[0]
        assert "重点" in text and "**" not in text and "](https" not in text
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_tool_events_are_never_sent_to_channels(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "tool_requested", "tool": "read"})
        harness.worker.push_event(session_id, {"type": "tool_result", "tool": "read"})
        await asyncio.sleep(0.05)
        assert harness.channel.sent == []
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_turn_completed_sends_reaction_when_supported(tmp_path):
    async def scenario(tmp_path):
        capabilities = ChannelCapabilities(supports_reaction=True)
        harness = await _harness(tmp_path, _Clock(), capabilities=capabilities)
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(lambda: harness.channel.reactions == ["✅"])
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_turn_failed_sends_one_line_with_short_session_id(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "turn_failed", "error": "模型\n连接 中断"})
        await _until(lambda: len(harness.channel.sent) == 1)
        expected = f"⚠️ 任务失败（模型 连接 中断）。可回复 /status 查看状态或重试。（session {session_id[:8]}）"
        assert _texts(harness.channel)[0] == expected
        assert harness.pump._turns == {}
        await _until(task.done)  # terminal event also unblocks the pending prompt
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_turn_cancelled_replies_stopped(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, {"type": "turn_cancelled", "reason": "user"})
        await _until(lambda: "已停止" in _texts(harness.channel))
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


# --- cursor tracking ----------------------------------------------------------------

def test_every_durable_event_advances_the_session_cursor(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        for event in ({"type": "turn_started"},
                      {"type": "assistant_message_completed", "content": "进度"},
                      {"type": "tool_requested", "tool": "read"},
                      {"type": "tool_result", "tool": "read"}):
            harness.worker.push_event(session_id, event)
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        key = "test:dm:chat"
        assert harness.router.cursor_for(key) == 5  # all durable events, tool ones included
        second = asyncio.create_task(harness.pump.inbound(_message("m-2", text="第二轮")))
        await _until(lambda: len(harness.worker.prompts) == 2)
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(lambda: harness.router.cursor_for(key) == 6)
        await _until(second.done)
        await _teardown(harness, second)

    asyncio.run(scenario(tmp_path))


def test_events_for_unrouted_sessions_are_ignored(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        stranger = harness.worker.new_session()  # exists on the worker, never routed
        await harness.client.subscribe(stranger)
        harness.worker.push_event(stranger, {"type": "turn_started"})
        harness.worker.push_event(stranger, {"type": "turn_completed"})
        await asyncio.sleep(0.05)
        assert harness.channel.sent == [] and harness.router.all_sessions() == {}
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))
