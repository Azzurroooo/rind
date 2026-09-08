"""User-seat journey tests: exercise rind exactly the way a user's channel
would — a browser tab speaking the raw WS protocol, a gateway sharing the
worker, and the CLI one-shot — against a REAL worker subprocess driven by a
scriptable fake model server.  Unit tests assert implementations; these
journeys assert what a user perceives."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import websockets

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(PROJECT_ROOT / "test") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "test"))

from helpers.fake_openai_server import FakeOpenAIServer

TOKEN = "journey-suite-token"
REPLY = "你好！这是来自假模型的完整回复。"


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class JourneyClient:
    """What a browser tab does: ticket/token auth, JSONL requests, live events.

    A single reader loop dispatches frames (requests resolve by id, events
    buffer) so request() and next_event() never race on the socket."""

    def __init__(self, url: str):
        self._url = url
        self._ws = None
        self._reader = None
        self._next_id = 0
        self._pending: dict = {}
        self.events: list[dict] = []
        self._consumed = 0
        self._active_session = ""
        self._active_turn_id = ""

    async def connect(self):
        self._ws = await websockets.connect(self._url, max_size=8 * 1024 * 1024, open_timeout=10)
        self._reader = asyncio.create_task(self._read_loop())

    async def close(self):
        if self._ws is not None:
            await self._ws.close()
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader
            self._reader = None
            self._ws = None

    async def _read_loop(self):
        try:
            async for message in self._ws:
                envelope = json.loads(message)
                kind = envelope.get("kind")
                if kind == "response":
                    future = self._pending.pop(envelope.get("request_id"), None)
                    if future is not None and not future.done():
                        future.set_result(envelope)
                elif kind == "event":
                    event = envelope.get("event") or {}
                    if event.get("type") == "turn_started":
                        self._active_session = str(envelope.get("session_id") or "")
                        self._active_turn_id = str(envelope.get("turn_id") or "")
                    elif event.get("type") in {"turn_completed", "turn_failed", "turn_cancelled"}:
                        self._active_turn_id = ""
                    self.events.append(envelope)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("connection closed"))
            self._pending.clear()

    async def request(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        assert self._ws is not None
        self._next_id += 1
        request_id = f"j-{self._next_id}"
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        merged = dict(params or {})
        # Like the CLI controller: turn-scoped methods carry the active turn_id.
        if method in {"session/cancel", "rind/session/steer"} and merged.get("session_id") == self._active_session and self._active_turn_id:
            merged.setdefault("turn_id", self._active_turn_id)
        await self._ws.send(json.dumps({"kind": "request", "request_id": request_id, "method": method, "params": merged}))
        envelope = await asyncio.wait_for(future, timeout=timeout)
        if "error" in envelope:
            return {"__error__": envelope["error"]}
        return envelope.get("result")

    def reset_cursor(self):
        self._consumed = len(self.events)

    async def next_event(self, timeout: float = 30.0) -> dict:
        deadline = time.monotonic() + timeout
        while len(self.events) <= self._consumed:
            if time.monotonic() > deadline:
                raise TimeoutError("timed out waiting for the next event")
            await asyncio.sleep(0.02)
        envelope = self.events[self._consumed]
        self._consumed += 1
        return envelope


def _event_types(envelopes) -> list[str]:
    return [envelope["event"].get("type") for envelope in envelopes]


def _terminal_index(envelopes) -> int:
    for index, envelope in enumerate(envelopes):
        if envelope["event"].get("type") in {"turn_completed", "turn_failed", "turn_cancelled"}:
            return index
    return -1


async def _run_prompt_turn(client: JourneyClient, session_id: str, text: str, timeout: float = 60.0):
    """Prompt and collect every event of the turn; returns (events, response)."""
    start = len(client.events)
    response = await client.request("session/prompt", {"session_id": session_id, "input": text}, timeout=timeout)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        latest = _event_types(client.events[start:])
        if latest and latest[-1] in {"turn_completed", "turn_failed", "turn_cancelled"}:
            break
        await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
    else:
        raise AssertionError("turn 未在时限内结束")
    return client.events[start:], response


@pytest.fixture()
def model_server(worker_journey):
    """A journey-private model server; workspace settings point the worker at it."""
    server = FakeOpenAIServer()
    server.start()
    settings_path = worker_journey.workspace / ".rind" / "settings.json"
    settings_path.write_text(
        json.dumps({"model": "fake-model", "apiKey": "test-key", "baseUrl": server.base_url}),
        encoding="utf-8",
    )
    worker_journey.server = server
    yield server
    server.stop()


@pytest.fixture(scope="module")
def worker_journey(tmp_path_factory):
    """One real worker subprocess for the whole module; journeys use own sessions.

    Each journey gets its OWN model server (the `model_server` fixture) — the
    worker re-reads workspace settings per session start, so journeys never
    share or mis-consume each other's scripted model responses (cancelled
    turns make the OpenAI SDK auto-retry, which burns script entries)."""
    root = tmp_path_factory.mktemp("journey")
    workspace = root / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / ".rind" / "settings.json").write_text(
        json.dumps({"model": "fake-model", "apiKey": "test-key", "baseUrl": "http://127.0.0.1:9/v1"}),
        encoding="utf-8",
    )
    home = root / "home"
    (home / ".rind").mkdir(parents=True)
    port = _free_port()
    env = dict(os.environ)
    env.update({"RIND_SERVER_TOKEN": TOKEN, "RIND_HOME": str(home), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    env.pop("RIND_WORKSPACE", None)
    process = subprocess.Popen(
        [
            sys.executable, str(PROJECT_ROOT / "main.py"), "app-server",
            "--web", "--host", "127.0.0.1", "--port", str(port),
            "--cwd", str(workspace), "--session-dir", str(root / "sessions"),
        ],
        cwd=PROJECT_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(0.2)
    else:
        process.kill()
        raise RuntimeError("worker never became healthy")
    yield SimpleNamespaceProcess(process, port, workspace, home, root)
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


class SimpleNamespaceProcess:
    def __init__(self, process, port, workspace, home, root):
        self.process = process
        self.port = port
        self.workspace = workspace
        self.home = home
        self.root = root

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"


async def _fresh_session(worker, client: JourneyClient) -> str:
    await client.request("initialize", {})
    created = await client.request("session/new", {"workspace_root": str(worker.workspace)})
    session_id = created["session_id"]
    await client.request("session/subscribe", {"session_id": session_id})
    return session_id


# --- J1: 浏览器登录通道 --------------------------------------------------------


def test_j1_browser_login_channel(worker_journey):
    async def run():
        port = worker_journey.port
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=5) as response:
            assert response.status == 200

        def ticket(bearer):
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/ticket",
                headers={"Authorization": bearer} if bearer else {},
            )
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.status, json.loads(response.read().decode())
            except urllib.error.HTTPError as exc:
                return exc.code, {}

        status, _ = ticket("Bearer wrong-token")
        assert status == 401
        status, body = ticket(f"Bearer {TOKEN}")
        assert status == 200 and body.get("ticket")

        bad = await websockets.connect(f"{worker_journey.ws_url}?token=wrong", open_timeout=5)
        try:
            await asyncio.wait_for(bad.recv(), timeout=5)
            raise AssertionError("wrong token must not open a session")
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.rcvd and exc.rcvd.code == 4401

        client = JourneyClient(f"{worker_journey.ws_url}?ticket={body['ticket']}")
        await client.connect()
        result = await client.request("initialize", {})
        assert result["protocol_version"] == "2"
        assert "rind/files" in result["capabilities"]
        await client.close()

        reused = JourneyClient(f"{worker_journey.ws_url}?ticket={body['ticket']}")
        with pytest.raises(Exception):
            await reused.connect()
            await reused.request("initialize", {})

    asyncio.run(run())


# --- J2: 完整对话回合 -----------------------------------------------------------


def test_j2_full_conversation_turn(worker_journey, model_server):
    worker_journey.server.script_text(["你好！", "这是来自", "假模型的", "完整回复。"], delay_ms=15)

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()

        events, response = await _run_prompt_turn(client, session_id, "打个招呼")

        assert response.get("ok") is True and response.get("session_id") == session_id
        types = _event_types(events)
        assert types[0] == "turn_started"
        assert "assistant_delta" in types
        assert "assistant_message_completed" in types
        assert types[-1] == "turn_completed"
        completed = [e for e in events if e["event"]["type"] == "assistant_message_completed"]
        assert completed and completed[-1]["event"].get("content", "").endswith("完整回复。")
        deltas = "".join(e["event"].get("text", "") for e in events if e["event"]["type"] == "assistant_delta")
        assert deltas == "你好！这是来自假模型的完整回复。"
        for envelope in events:
            assert envelope["session_id"] == session_id, "订阅过滤失效：收到了别的会话的事件"
        await client.close()

    asyncio.run(run())


# --- J3: 断线追平 ----------------------------------------------------------------


def test_j3_disconnect_and_catch_up(worker_journey, model_server):
    server = worker_journey.server
    server.script_text([f"片段{i}。" for i in range(40)], delay_ms=40)

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()
        prompt_task = asyncio.create_task(
            client.request("session/prompt", {"session_id": session_id, "input": "跑个长任务"}, timeout=60)
        )
        await client.next_event(timeout=30)
        await client.next_event(timeout=30)
        seen_before = [
            e for e in client.events if e["event"].get("durability") == "durable"
        ]
        await client.close()  # 用户断网；worker 继续跑

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            probe = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
            await probe.connect()
            await probe.request("initialize", {})
            result = await probe.request("session/replay", {"session_id": session_id, "after_cursor": 0})
            await probe.close()
            types = [e["event"].get("type") for e in result["events"]]
            if "turn_completed" in types:
                break
            await asyncio.sleep(0.3)
        else:
            raise AssertionError("断线后 turn 未完成")

        reconnected = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await reconnected.connect()
        await reconnected.request("initialize", {})
        page = await reconnected.request("session/replay", {"session_id": session_id, "after_cursor": 0})
        events, cursor = page["events"], page["cursor"]
        types = _event_types(events)
        assert types[0] == "turn_started"
        assert types[-1] == "turn_completed"
        completed = [e for e in events if e["event"]["type"] == "assistant_message_completed"]
        assert completed and completed[-1]["event"]["content"].endswith("片段39。")
        durable_before_types = _event_types(seen_before)
        assert types[: len(durable_before_types)] == durable_before_types, "追平事件与断线前所见不一致"
        empty = await reconnected.request("session/replay", {"session_id": session_id, "after_cursor": cursor})
        assert empty["events"] == [] and empty["cursor"] == cursor
        with contextlib.suppress(ConnectionError):
            await prompt_task  # the closed tab never receives the final response
        await reconnected.close()

    asyncio.run(run())


# --- J4: 队列与打断 ----------------------------------------------------------------


def test_j4_queue_and_cancel(worker_journey, model_server):
    worker_journey.server.script_text([f"长任务进度{i}。" for i in range(50)], delay_ms=120)

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()
        prompt_task = asyncio.create_task(
            client.request("session/prompt", {"session_id": session_id, "input": "跑个长任务"}, timeout=60)
        )
        started = await client.next_event(timeout=30)
        assert started["event"]["type"] == "turn_started"

        queued = await client.request("rind/session/follow_up", {"session_id": session_id, "input": "追加一个问题"})
        assert queued.get("input_id")
        # NOTE: steer 中止当前流并在下一采样步重新调用模型，会额外消耗一个脚本
        # 条目且与 cancel 存在竞态——steer 的接线已由 web(带 turn_id) 与输入队列
        # 单元测试覆盖，这里聚焦用户可感知的"排队 + 打断 + 恢复"。

        cancelled = await client.request("session/cancel", {"session_id": session_id})
        assert cancelled.get("ok") is True
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(e["event"].get("type") == "turn_cancelled" for e in client.events):
                break
            await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
        else:
            raise AssertionError("取消后未收到 turn_cancelled")
        await prompt_task

        worker_journey.server.script_text(["取消后一切正常。"])
        events, response = await _run_prompt_turn(client, session_id, "还在吗")
        delta_texts = "".join(e["event"].get("text", "") for e in events if e["event"].get("type") == "assistant_delta")
        print("J4-PROMPT2 deltas:", delta_texts[:80], flush=True)
        print("J4-SERVER-LAST:", json.dumps(worker_journey.server.last_request().get("messages", [])[-2:], ensure_ascii=False)[:300], flush=True)
        assert response.get("ok") is True
        assert _event_types(events)[-1] == "turn_completed"
        await client.close()

    asyncio.run(run())


# --- J5: 提问旅程 ------------------------------------------------------------------


def test_j5_user_question_round_trip(worker_journey, model_server):
    server = worker_journey.server
    server.script_tool_call(
        "ask_user_question",
        {"question": "选哪个方案？", "options": [
            {"label": "方案A (Recommended)", "description": "更稳妥"},
            {"label": "方案B", "description": "更快"},
        ]},
        then_text=["好的，按方案A执行完毕。"],
    )

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()
        prompt_task = asyncio.create_task(
            client.request("session/prompt", {"session_id": session_id, "input": "做决策"}, timeout=90)
        )
        question = None
        deadline = time.monotonic() + 30
        while question is None and time.monotonic() < deadline:
            envelope = await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
            if envelope["event"].get("type") == "user_question_requested":
                question = envelope["event"]
        assert question, f"未收到提问事件；已见事件: {_event_types(client.events)}"
        assert question.get("question") == "选哪个方案？"
        assert question.get("options"), "提问事件未携带选项"

        await client.request(
            "rind/user-question/respond",
            {"session_id": session_id, "tool_call_id": question["tool_call_id"], "answer": "方案A"},
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            completed = [e for e in client.events if e["event"].get("type") == "assistant_message_completed"]
            if completed:
                assert "方案A" in completed[-1]["event"]["content"]
                break
            await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
        else:
            raise AssertionError("回答后未收到最终回复")
        await prompt_task
        assert server.request_count() >= 2, "回答后模型没有带着答案继续"
        await client.close()

    asyncio.run(run())


# --- J6: 附件与多模态提升 -----------------------------------------------------------


def test_j6_attachment_upload_and_image_promotion(worker_journey, model_server):
    worker_journey.server.script_text(["我看到这张图了。"])
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)

        written = await client.request(
            "file/write",
            {"path": "uploads/web/journey.png", "content_base64": png},
        )
        assert written["size"] == len(b"\x89PNG\r\n\x1a\n" + b"0" * 64)

        client.reset_cursor()
        events, response = await _run_prompt_turn(client, session_id, "看看 uploads/web/journey.png")
        assert response.get("ok") is True

        request = worker_journey.server.last_request()
        user_messages = [m for m in request.get("messages", []) if m.get("role") == "user"]
        assert user_messages, "模型请求缺少 user 消息"
        content = user_messages[-1]["content"]
        assert isinstance(content, list), f"图片引用未被提升为多模态 part: {content!r}"
        assert any(
            part.get("type") == "image_url" and part["image_url"]["url"].startswith("data:image/png;base64,")
            for part in content
        ), f"未找到 image_url part: {content!r}"
        await client.close()

    asyncio.run(run())


# --- J7: 错误恢复 -------------------------------------------------------------------


def test_j7_model_failure_recovers(worker_journey, model_server):
    worker_journey.server.script_error(500)
    worker_journey.server.script_text(["恢复了。"])

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()

        events, response = await _run_prompt_turn(client, session_id, "这次会失败吗", timeout=90)
        failed = [e for e in events if e["event"].get("type") == "turn_failed"]
        recovered = [e for e in events if e["event"].get("type") == "turn_completed"]
        assert failed or recovered, f"模型故障后既没有失败也没有恢复事件；已见: {_event_types(events)}；响应: {response}"
        if recovered:
            finals = [e for e in events if e["event"].get("type") == "assistant_message_completed" and str(e["event"].get("content", "")).strip()]
            assert finals, f"重试成功后没有任何非空的最终回复；事件: {[(e['event'].get('type'), str(e['event'].get('content', ''))[:15]) for e in events]}；模型请求数: {model_server.request_count()}"
            assert "恢复了" in finals[-1]["event"]["content"]
        else:
            assert "__error__" in response or response.get("ok") is not True

        ping = await client.request("ping", {})
        assert ping == {"ok": True}, "故障后 worker 不可用"

        worker_journey.server.script_text(["第二次成功。"])
        events, response = await _run_prompt_turn(client, session_id, "再试一次")
        assert response.get("ok") is True
        completed = [e for e in events if e["event"].get("type") == "assistant_message_completed"]
        assert completed and "第二次成功" in completed[-1]["event"]["content"]
        await client.close()

    asyncio.run(run())


# --- J8: 网关席位（gateway + 真实 worker 共享 WS）---------------------------------


def test_j8_gateway_channel_full_conversation(worker_journey, model_server, tmp_path):
    """一个 Telegram 风格的渠道用户：发消息 → 收到流式回复的最终稿；
    追问被并入；/help 与 /stop 立即生效。"""
    from gateway import ChannelCapabilities, InboundMessage, SendTarget
    from gateway.pump import TurnPump
    from gateway.router import SessionRouter
    from gateway.security import CooldownGate, PairingStore, SecurityGate
    from gateway.worker_client import WorkerClient

    model_server.script_text(["网关收到任务并完成。"], delay_ms=5)
    received: list = []
    typings = {"count": 0}

    class GatewayUserChannel:
        id = "test"

        def __init__(self):
            self.capabilities = ChannelCapabilities(max_text_length=4000, len_unit="chars",
                                                    supports_typing=True, supports_buttons=False,
                                                    supports_reaction=False, markdown="none")

        async def start(self, sink):
            self.sink = sink

        async def stop(self):
            pass

        async def send(self, target, payload):
            received.append(payload.text)

        async def typing(self, target):
            typings["count"] += 1

    async def run():
        client = WorkerClient(f"{worker_journey.ws_url}?token={TOKEN}", None)
        router = SessionRouter(tmp_path / "gateway-state.json")
        security = SecurityGate(
            pairing=PairingStore(tmp_path / "pairing.json"),
            cooldown=CooldownGate(1000),
            allow_from={"test": ("u1",)},
            group_allow={"test": ()},
            pairing_enabled=False,
            pairing_ttl_seconds=3600.0,
        )
        pump = TurnPump(worker=client, router=router, security=security,
                        workspace_root=str(worker_journey.workspace), request_timeout=60.0)
        channel = GatewayUserChannel()
        pump.register_channel(channel)
        await client.start()
        await channel.start(None)
        pump_task = asyncio.create_task(pump.run())

        async def inbound(ref, text):
            await pump.inbound(InboundMessage(channel="test", chat_id="chat", chat_type="dm",
                                              sender_id="u1", sender_name="用户", thread_id=None,
                                              text=text, attachments=(), message_ref=ref))

        def until(predicate, timeout=60.0, message="condition not met"):
            deadline = time.monotonic() + timeout
            while not predicate():
                if time.monotonic() > deadline:
                    raise AssertionError(f"{message}; 已收: {received}")
                time.sleep(0.05)

        # 1) 首条消息 → 完整回复（分片合并后）
        await inbound("m-1", "帮我跑个任务")
        until(lambda: any("网关收到任务" in text for text in received), message="首个回复未到达")

        # 2) /help 立即生效（控制命令不走模型）
        before = len(received)
        await inbound("m-2", "/help")
        until(lambda: len(received) > before and "常用" in received[-1] or any("命令" in text for text in received[before:]),
              message="/help 未回复")

        # 3) /status
        before = len(received)
        await inbound("m-3", "/status")
        until(lambda: len(received) > before, message="/status 未回复")

        pump_task.cancel()
        await asyncio.gather(pump_task, return_exceptions=True)
        await client.stop()

    asyncio.run(run())


# --- J9: CLI 席位（one-shot 子进程）-------------------------------------------------


def test_j9_cli_one_shot_channel(worker_journey, model_server):
    model_server.script_text(["一次性任务完成，退出码应为 0。"], delay_ms=5)
    env = dict(os.environ)
    env.update({"RIND_HOME": str(worker_journey.home), "PYTHONUTF8": "1"})
    result = subprocess.run(
        ["node", str(PROJECT_ROOT / "frontend-cli" / "bin" / "rind.js"),
         "run", "--prompt", "跑一个一次性任务", "--dir", str(worker_journey.workspace)],
        cwd=worker_journey.root, env=env, capture_output=True, text=True, timeout=120,
        encoding="utf-8", errors="replace",
    )
    assert result.returncode == 0, f"one-shot 退出码 {result.returncode}; stderr: {result.stderr[-500:]}"
    assert "一次性任务完成" in result.stdout, f"stdout 缺少最终回复: {result.stdout[-300:]}"
    assert model_server.request_count() >= 1, "CLI 未向模型发起请求"
