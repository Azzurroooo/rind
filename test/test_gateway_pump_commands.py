"""Pump decision-row integration for text commands (row 4, before questions).

Uses the same FakeWorker harness as test_gateway_pump.py: /help /status /new
/compact /unknown run as control traffic between the security verdict and the
question row, keep LRU dedup, never create sessions or prompts, don't swallow
digit answers, and queue with a notice while the worker is offline.
"""

import asyncio
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import ChannelCapabilities, InboundMessage, OutboundPayload, SendTarget  # noqa: E402
from gateway.commands import (  # noqa: E402
    COMPACT_ACK,
    NO_SESSION_REPLY,
    OFFLINE_NOTICE,
    STOPPED_REPLY,
    UNKNOWN_REPLY,
)
from gateway.fake_worker import FakeWorker  # noqa: E402
from gateway.pump import TurnPump  # noqa: E402
from gateway.router import SessionRouter  # noqa: E402
from gateway.security import CooldownGate, PairingStore, SecurityGate  # noqa: E402
from gateway.worker_client import WorkerClient, WorkerConnectionError  # noqa: E402

REQUEST_TIMEOUT = 5.0


class _MemTransport:
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
    await harness.client.stop()
    for task in tasks:
        if task is not None and not task.done():
            task.cancel()
    await asyncio.gather(*(t for t in tasks if t is not None), return_exceptions=True)


async def _start_turn(harness, ref="m-1", text="帮我做一件事"):
    task = asyncio.create_task(harness.pump.inbound(_message(ref, text)))
    await _until(lambda: harness.worker.prompts, message="prompt never reached worker")
    return task, harness.worker.prompts[0][0]


def _texts(channel):
    return [payload.text for payload in channel.sent]


def _question_event(options=("甲", "乙")):
    return {"type": "user_question_requested", "question": "选一个：", "tool_call_id": "q-1",
            "options": [{"label": label} for label in options]}


# --- row 4: commands are control traffic -------------------------------------------


def test_help_replies_tiered_list_without_touching_worker(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/help"))
        text = _texts(harness.channel)[0]
        assert text.startswith("常用：") and "全部：" in text
        for name in ("/new", "/status", "/stop", "/compact", "/help"):
            assert name in text
        assert harness.worker.prompts == [] and harness.worker.created == []  # no session, no prompt
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


def test_status_composes_idle_then_running_state(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/status"))
        idle = _texts(harness.channel)[0]
        assert "任务：空闲" in idle and "worker：已连接" in idle and "会话：0 个" in idle
        task, session_id = await _start_turn(harness, ref="m-2")
        await harness.pump.inbound(_message("m-3", text="/status"))
        running = _texts(harness.channel)[-1]
        assert "任务：运行中" in running and "会话：1 个" in running and session_id[:8] not in running
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_new_creates_session_and_rebinds_follow_up_prompts(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/new"))
        first = _texts(harness.channel)[0]
        assert first.startswith("已开启新会话（session ")
        session_a = harness.router.lookup("test:dm:chat").session_id
        assert harness.worker.created and harness.worker.prompts == []  # no prompt for commands

        task, _prompted = await _start_turn(harness, ref="m-2", text="在会话里干活")
        assert _prompted == session_a  # subsequent prompts land in the /new session
        harness.worker.push_event(session_a, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_new_cancels_running_turn_then_opens_fresh_session(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        await harness.pump.inbound(_message("m-2", text="/new"))
        assert harness.worker.cancels == [session_id]  # old turn stopped first
        await _until(lambda: any(t == STOPPED_REPLY for t in _texts(harness.channel)))  # cancel receipt
        await _until(lambda: any(t.startswith("已开启新会话") for t in _texts(harness.channel)))
        fresh = harness.router.lookup("test:dm:chat").session_id
        assert fresh != session_id
        second = asyncio.create_task(harness.pump.inbound(_message("m-3", text="新会话任务")))
        await _until(lambda: len(harness.worker.prompts) == 2)
        assert harness.worker.prompts[1][0] == fresh  # next prompt targets the fresh session
        assert harness.worker.follow_ups == []  # the cancelled turn never swallowed the prompt
        harness.worker.push_event(fresh, {"type": "turn_completed"})
        await _until(second.done)
        await _teardown(harness, task, second)

    asyncio.run(scenario(tmp_path))


def test_compact_requests_for_routed_session(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/compact"))
        assert _texts(harness.channel) == [NO_SESSION_REPLY]  # nothing routed yet
        await harness.pump.inbound(_message("m-2", text="/new"))
        session_id = harness.router.lookup("test:dm:chat").session_id
        await harness.pump.inbound(_message("m-3", text="/compact"))
        assert harness.worker.compacts == [session_id]
        assert COMPACT_ACK in _texts(harness.channel)
        assert harness.worker.prompts == []
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


def test_unknown_command_gets_hint_and_never_becomes_prompt(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/deploy prod"))
        await harness.pump.inbound(_message("m-2", text="/"))
        assert _texts(harness.channel) == [UNKNOWN_REPLY, UNKNOWN_REPLY]
        assert harness.worker.prompts == [] and harness.worker.created == []
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


def test_commands_do_not_swallow_question_digits(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        task, session_id = await _start_turn(harness)
        harness.worker.push_event(session_id, _question_event())
        await _until(lambda: harness.pump._questions != {})
        await harness.pump.inbound(_message("m-2", text="/help"))  # command row runs, question kept
        assert harness.worker.answers == [] and any("常用：" in t for t in _texts(harness.channel))
        assert harness.pump._questions != {}  # the question survived the command
        await harness.pump.inbound(_message("m-3", text="2"))  # digits still answer first
        assert harness.worker.answers == [(session_id, "q-1", "乙")]
        harness.worker.push_event(session_id, {"type": "turn_completed"})
        await _until(task.done)
        await _teardown(harness, task)

    asyncio.run(scenario(tmp_path))


def test_commands_keep_lru_dedup(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())
        await harness.pump.inbound(_message("m-1", text="/status"))
        await harness.pump.inbound(_message("m-1", text="/status"))  # same ref → dropped
        assert len(_texts(harness.channel)) == 1
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


def test_offline_command_queues_with_notice_then_flushes_as_command(tmp_path):
    async def scenario(tmp_path):
        harness = await _harness(tmp_path, _Clock())

        class _StubWorker:
            def __init__(self):
                self.connected = False
                self.requests = []
                self.created = []
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
                if method == "session/new":
                    return {"session_id": "s-off-1"}
                return {"ok": True}

        stub = _StubWorker()
        pump = harness.pump
        pump._worker = stub
        stub.on_event(pump.handle_event)
        await pump.inbound(_message("m-1", text="/new"))  # offline → queued + notice
        assert _texts(harness.channel) == [OFFLINE_NOTICE]
        assert len(pump._pending_inbound) == 1

        stub.connected = True
        await pump.inbound(_message("m-2", text="/status"))  # flush runs first, as its command
        assert any(t.startswith("已开启新会话") for t in _texts(harness.channel))
        assert any("任务：" in t for t in _texts(harness.channel))  # the queued /new executed
        methods = [method for method, _params in stub.requests]
        assert methods.count("session/new") == 1  # command replay, not a prompt
        await _teardown(harness)

    asyncio.run(scenario(tmp_path))


from gateway.worker_client import WorkerConnectionError  # noqa: E402  (used by the offline stub)
