"""CommandHub tests: the tiered registry, dispatch, and handler behavior.

The hub is tested against a fake worker + real SessionRouter + fake pump
links, so every handler path (status composition, /new force-create, /compact
targeting, /stop silence, /help tiering, unknown names, failure mapping) is
covered without the pump.  Pump-row integration lives in
test_gateway_pump_commands.py.
"""

import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import InboundMessage, SendTarget  # noqa: E402
from gateway.commands import (  # noqa: E402
    COMMANDS,
    COMPACT_ACK,
    NO_SESSION_REPLY,
    OFFLINE_NOTICE,
    UNKNOWN_REPLY,
    CommandContext,
    CommandHub,
    HubLinks,
    command_name,
    is_command,
)
from gateway.errors import TIMEOUT_LINE
from gateway.router import SessionRouter
from gateway.worker_client import WorkerTimeout  # noqa: E402

WORKSPACE = "/ws"


class _FakeWorker:
    def __init__(self, *, connected=True):
        self.connected = connected
        self.requests: list[tuple[str, dict]] = []
        self.subscriptions: list[str] = []
        self.fail_methods: set[str] = set()

    async def request(self, method, params, timeout=None):
        if method in self.fail_methods:
            raise WorkerTimeout(f"worker request timed out: {method}")
        self.requests.append((method, dict(params)))
        if method == "session/new":
            return {"session_id": f"fresh-{len(self.requests)}"}
        return {"ok": True}

    async def subscribe(self, session_id):
        self.subscriptions.append(session_id)


def _ctx(key="test:dm:chat"):
    message = InboundMessage(channel="test", chat_id="chat", chat_type="dm", sender_id="u1",
                             sender_name="n", thread_id=None, text="/status", attachments=(),
                             message_ref="m-1")
    return CommandContext(channel_id="test", target=SendTarget(chat_id="chat"), message=message, key=key)


def _hub(tmp_path, worker=None, *, active=None, queue=0, finish=None):
    worker = worker or _FakeWorker()
    router = SessionRouter(tmp_path / "state.json")
    binds: list[tuple[str, tuple[str, SendTarget]]] = []
    links = HubLinks(active_session=active or (lambda key: None),
                     finish_turn=finish or _noop_finish,
                     queue_depth=lambda: queue,
                     bind_target=lambda session_id, position: binds.append((session_id, position)))
    hub = CommandHub(worker_getter=lambda: worker, router=router, links=links,
                     workspace_root=WORKSPACE, request_timeout=1.0)
    return hub, worker, router, binds


async def _noop_finish(key):
    return None


def run(coro):
    return asyncio.run(coro)


# --- registry and parsing -------------------------------------------------------------


def test_registry_is_tiered_and_single_source():
    essential = {name for name, spec in COMMANDS.items() if spec.tier == "essential"}
    assert essential == {"stop", "new", "status", "compact"}
    assert set(COMMANDS) == essential | {"help"}
    assert COMMANDS["help"].tier == "standard"


def test_is_command_and_name_parsing():
    assert is_command("/status") and is_command("/help 现在")
    assert not is_command("1") and not is_command("你好 /status") and not is_command("")
    assert command_name("/status") == "status"
    assert command_name("/Help") == "help"
    assert command_name("/compact now") == "compact"
    assert command_name("/") == ""


def test_offline_notice_constant_is_shared():
    assert OFFLINE_NOTICE == "worker 离线，命令暂存"


# --- /help ------------------------------------------------------------------------------


def test_help_renders_tiered_list(tmp_path):
    async def scenario():
        hub, *_ = _hub(tmp_path)
        text = await hub.dispatch("/help", _ctx())
        assert text.startswith("常用：")
        essential_block, full_block = text.split("全部：")
        for name in ("stop", "new", "status", "compact"):
            assert f"/{name}" in essential_block
        assert "/help" in full_block
        assert "/stop 停止当前任务" in text

    run(scenario())


# --- /status ------------------------------------------------------------------------


def test_status_composes_local_state_only(tmp_path):
    async def scenario():
        hub, worker, router, _ = _hub(tmp_path, active=lambda key: "sess-1", queue=2)
        router._register("test:dm:chat", "sess-1")
        router._register("other:dm:x", "sess-2")
        worker.connected = True
        text = await hub.dispatch("/status", _ctx())
        assert "模型：" in text
        assert "任务：运行中（排队 2）" in text
        assert "会话：2 个" in text
        assert "worker：已连接" in text
        assert worker.requests == []  # no protocol call: composed from local state

    run(scenario())


def test_status_idle_and_disconnected(tmp_path):
    async def scenario():
        hub, worker, _router, _ = _hub(tmp_path)
        worker.connected = False
        text = await hub.dispatch("/status", _ctx())
        assert "任务：空闲" in text and "worker：离线" in text and "会话：0 个" in text

    run(scenario())


# --- /new ---------------------------------------------------------------------------


def test_new_creates_fresh_session_binds_target_and_subscribes(tmp_path):
    async def scenario():
        hub, worker, router, binds = _hub(tmp_path)
        reply = await hub.dispatch("/new", _ctx())
        assert reply and reply.startswith("已开启新会话（session fresh-")
        created = [params for method, params in worker.requests if method == "session/new"]
        assert created and created[0]["workspace_root"] == WORKSPACE
        assert worker.subscriptions == [router.lookup("test:dm:chat").session_id]
        assert binds and binds[0][0] == router.lookup("test:dm:chat").session_id

    run(scenario())


def test_new_cancels_active_turn_first(tmp_path):
    async def scenario():
        finished: list[str] = []

        async def finish(key):
            finished.append(key)

        hub, worker, _router, _ = _hub(tmp_path, active=lambda key: "old-session", finish=finish)
        reply = await hub.dispatch("/new", _ctx())
        cancels = [params for method, params in worker.requests if method == "session/cancel"]
        assert cancels == [{"session_id": "old-session"}]
        assert finished == ["test:dm:chat"]
        assert reply and "已开启新会话" in reply

    run(scenario())


def test_new_failure_replies_one_line(tmp_path):
    async def scenario():
        class _DownWorker(_FakeWorker):
            async def request(self, method, params, timeout=None):
                raise TimeoutError("session/new timed out")

        hub, *_ = _hub(tmp_path, _DownWorker())
        reply = await hub.dispatch("/new", _ctx())
        assert reply == "暂时无法创建会话，稍后再试"

    run(scenario())


# --- /compact ------------------------------------------------------------------------


def test_compact_prefers_active_turn_session_then_router_record(tmp_path):
    async def scenario():
        hub, worker, _router, _ = _hub(tmp_path, active=lambda key: "live-session")
        assert await hub.dispatch("/compact", _ctx()) == COMPACT_ACK
        assert worker.requests[-1] == ("rind/session/compact", {"session_id": "live-session"})

        hub, worker, router, _ = _hub(tmp_path)  # idle: fall back to the routed session
        router._register("test:dm:chat", "stored-session")
        assert await hub.dispatch("/compact", _ctx()) == COMPACT_ACK
        assert worker.requests[-1] == ("rind/session/compact", {"session_id": "stored-session"})

    run(scenario())


def test_compact_without_session_and_failure_paths(tmp_path):
    async def scenario():
        hub, worker, _router, _ = _hub(tmp_path)  # nothing routed
        assert await hub.dispatch("/compact", _ctx()) == NO_SESSION_REPLY

        hub, worker, _router, _ = _hub(tmp_path, active=lambda key: "sess")
        worker.fail_methods.add("rind/session/compact")
        reply = await hub.dispatch("/compact", _ctx())
        assert reply == TIMEOUT_LINE  # dispatch maps WorkerError through user_error_line

    run(scenario())


# --- /stop and unknown ------------------------------------------------------------------


def test_stop_without_active_turn_is_silent(tmp_path):
    async def scenario():
        hub, worker, _router, _ = _hub(tmp_path)
        assert await hub.dispatch("/stop", _ctx()) is None
        assert worker.requests == []

    run(scenario())


def test_unknown_command_gets_help_hint(tmp_path):
    async def scenario():
        hub, worker, _router, _ = _hub(tmp_path)
        assert await hub.dispatch("/queue", _ctx()) == UNKNOWN_REPLY
        assert await hub.dispatch("/nope", _ctx()) == UNKNOWN_REPLY
        assert worker.requests == []  # unknown slash text never becomes a prompt

    run(scenario())
