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
REPLY = "Hello! This is a complete reply from the fake model."


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
        raise AssertionError("turn did not finish within the timeout")
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


# --- J1: browser login channel --------------------------------------------------------


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


# --- J2: full conversation turn -----------------------------------------------------------


def test_j2_full_conversation_turn(worker_journey, model_server):
    worker_journey.server.script_text(["Hello!", " This is a", " complete reply", " from the fake model."], delay_ms=15)

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()

        events, response = await _run_prompt_turn(client, session_id, "say hello")

        assert response.get("ok") is True and response.get("session_id") == session_id
        types = _event_types(events)
        assert types[0] == "turn_started"
        assert "assistant_delta" in types
        assert "assistant_message_completed" in types
        assert types[-1] == "turn_completed"
        completed = [e for e in events if e["event"]["type"] == "assistant_message_completed"]
        assert completed and completed[-1]["event"].get("content", "").endswith("fake model.")
        deltas = "".join(e["event"].get("text", "") for e in events if e["event"]["type"] == "assistant_delta")
        assert deltas == "Hello! This is a complete reply from the fake model."
        for envelope in events:
            assert envelope["session_id"] == session_id, "subscription filter broken: received events from another session"
        await client.close()

    asyncio.run(run())


# --- J3: disconnect and catch-up ----------------------------------------------------------------


def test_j3_disconnect_and_catch_up(worker_journey, model_server):
    server = worker_journey.server
    server.script_text([f"segment {i}." for i in range(40)], delay_ms=40)

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()
        prompt_task = asyncio.create_task(
            client.request("session/prompt", {"session_id": session_id, "input": "run a long task"}, timeout=60)
        )
        await client.next_event(timeout=30)
        await client.next_event(timeout=30)
        seen_before = [
            e for e in client.events if e["event"].get("durability") == "durable"
        ]
        await client.close()  # the user goes offline; the worker keeps running

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
            raise AssertionError("turn did not complete after the disconnect")

        reconnected = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await reconnected.connect()
        await reconnected.request("initialize", {})
        page = await reconnected.request("session/replay", {"session_id": session_id, "after_cursor": 0})
        events, cursor = page["events"], page["cursor"]
        types = _event_types(events)
        assert types[0] == "turn_started"
        assert types[-1] == "turn_completed"
        completed = [e for e in events if e["event"]["type"] == "assistant_message_completed"]
        assert completed and completed[-1]["event"]["content"].endswith("segment 39.")
        durable_before_types = _event_types(seen_before)
        assert types[: len(durable_before_types)] == durable_before_types, "replayed events do not match what was seen before the disconnect"
        empty = await reconnected.request("session/replay", {"session_id": session_id, "after_cursor": cursor})
        assert empty["events"] == [] and empty["cursor"] == cursor
        with contextlib.suppress(ConnectionError):
            await prompt_task  # the closed tab never receives the final response
        await reconnected.close()

    asyncio.run(run())


# --- J4: queueing and interruption ----------------------------------------------------------------


def test_j4_queue_and_cancel(worker_journey, model_server):
    worker_journey.server.script_text([f"long task progress {i}." for i in range(50)], delay_ms=120)

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()
        prompt_task = asyncio.create_task(
            client.request("session/prompt", {"session_id": session_id, "input": "run a long task"}, timeout=60)
        )
        started = await client.next_event(timeout=30)
        assert started["event"]["type"] == "turn_started"

        queued = await client.request("rind/session/follow_up", {"session_id": session_id, "input": "one more question"})
        assert queued.get("input_id")
        # NOTE: steer aborts the current stream and re-calls the model at the
        # next sampling step, burning an extra script entry and racing with
        # cancel — steer wiring is covered by the web (with turn_id) and
        # input-queue unit tests; here we focus on the user-visible
        # queue + interrupt + resume.

        cancelled = await client.request("session/cancel", {"session_id": session_id})
        assert cancelled.get("ok") is True
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(e["event"].get("type") == "turn_cancelled" for e in client.events):
                break
            await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
        else:
            raise AssertionError("turn_cancelled not received after the cancel")
        await prompt_task

        worker_journey.server.script_text(["All good after the cancel."])
        events, response = await _run_prompt_turn(client, session_id, "are you still there")
        delta_texts = "".join(e["event"].get("text", "") for e in events if e["event"].get("type") == "assistant_delta")
        print("J4-PROMPT2 deltas:", delta_texts[:80], flush=True)
        print("J4-SERVER-LAST:", json.dumps(worker_journey.server.last_request().get("messages", [])[-2:], ensure_ascii=False)[:300], flush=True)
        assert response.get("ok") is True
        assert _event_types(events)[-1] == "turn_completed"
        await client.close()

    asyncio.run(run())


# --- J5: question journey ------------------------------------------------------------------


def test_j5_user_question_round_trip(worker_journey, model_server):
    server = worker_journey.server
    server.script_tool_call(
        "ask_user_question",
        {"question": "Which option should we pick?", "options": [
            {"label": "Option A (Recommended)", "description": "safer"},
            {"label": "Option B", "description": "faster"},
        ]},
        then_text=["OK, done executing Option A."],
    )

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()
        prompt_task = asyncio.create_task(
            client.request("session/prompt", {"session_id": session_id, "input": "make the decision"}, timeout=90)
        )
        question = None
        deadline = time.monotonic() + 30
        while question is None and time.monotonic() < deadline:
            envelope = await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
            if envelope["event"].get("type") == "user_question_requested":
                question = envelope["event"]
        assert question, f"no question event received; events seen: {_event_types(client.events)}"
        assert question.get("question") == "Which option should we pick?"
        assert question.get("options"), "question event carried no options"

        await client.request(
            "rind/user-question/respond",
            {"session_id": session_id, "tool_call_id": question["tool_call_id"], "answer": "Option A"},
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            completed = [e for e in client.events if e["event"].get("type") == "assistant_message_completed"]
            if completed:
                assert "Option A" in completed[-1]["event"]["content"]
                break
            await client.next_event(timeout=max(1.0, deadline - time.monotonic()))
        else:
            raise AssertionError("no final reply received after answering")
        await prompt_task
        assert server.request_count() >= 2, "model did not continue with the answer after responding"
        await client.close()

    asyncio.run(run())


# --- J6: attachments and multimodal promotion -----------------------------------------------------------


def test_j6_attachment_upload_and_image_snapshot(worker_journey, model_server):
    worker_journey.server.script_text(["I can see this image."])
    import io
    from PIL import Image
    output = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(output, format="PNG")
    png = base64.b64encode(output.getvalue()).decode()

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)

        written = await client.request(
            "file/write",
            {"path": "uploads/web/journey.png", "content_base64": png},
        )
        assert written["size"] == len(output.getvalue())

        client.reset_cursor()
        events, response = await _run_prompt_turn(client, session_id, "look at uploads/web/journey.png")
        assert response.get("ok") is True

        request = worker_journey.server.last_request()
        user_messages = [m for m in request.get("messages", []) if m.get("role") == "user"]
        assert user_messages, "model request is missing the user message"
        content = user_messages[-1]["content"]
        assert isinstance(content, list), f"image reference was not promoted to a multimodal part: {content!r}"
        assert any(
            part.get("type") == "image_url" and part["image_url"]["url"] == "data:image/png;base64," + png
            for part in content
        ), f"no image_url part found: {content!r}"
        await client.close()

    asyncio.run(run())


# --- J7: error recovery -------------------------------------------------------------------


def test_j7_model_failure_recovers(worker_journey, model_server):
    worker_journey.server.script_error(500)
    worker_journey.server.script_text(["Recovered."])

    async def run():
        client = JourneyClient(f"{worker_journey.ws_url}?token={TOKEN}")
        await client.connect()
        session_id = await _fresh_session(worker_journey, client)
        client.reset_cursor()

        events, response = await _run_prompt_turn(client, session_id, "will this fail", timeout=90)
        failed = [e for e in events if e["event"].get("type") == "turn_failed"]
        recovered = [e for e in events if e["event"].get("type") == "turn_completed"]
        assert failed or recovered, f"neither a failure nor a recovery event after the model outage; seen: {_event_types(events)}; response: {response}"
        if recovered:
            finals = [e for e in events if e["event"].get("type") == "assistant_message_completed" and str(e["event"].get("content", "")).strip()]
            assert finals, f"no non-empty final reply after the successful retry; events: {[(e['event'].get('type'), str(e['event'].get('content', ''))[:15]) for e in events]}; model requests: {model_server.request_count()}"
            assert "Recovered" in finals[-1]["event"]["content"]
        else:
            assert "__error__" in response or response.get("ok") is not True

        ping = await client.request("ping", {})
        assert ping == {"ok": True}, "worker unavailable after the failure"

        worker_journey.server.script_text(["Second attempt succeeded."])
        events, response = await _run_prompt_turn(client, session_id, "try again")
        assert response.get("ok") is True
        completed = [e for e in events if e["event"].get("type") == "assistant_message_completed"]
        assert completed and "Second attempt succeeded" in completed[-1]["event"]["content"]
        await client.close()

    asyncio.run(run())


# --- J8: gateway seat (gateway + real worker sharing WS) ---------------------------------


def test_j8_gateway_channel_full_conversation(worker_journey, model_server, tmp_path):
    """A Telegram-style channel user: send a message → receive the final
    draft of the streamed reply; follow-ups get merged in; /help and /stop
    take effect immediately."""
    from gateway import ChannelCapabilities, InboundMessage, SendTarget
    from gateway.pump import TurnPump
    from gateway.router import SessionRouter
    from gateway.security import CooldownGate, PairingStore, SecurityGate
    from gateway.worker_client import WorkerClient

    model_server.script_text(["Gateway got the task and finished it."], delay_ms=5)
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
                                              sender_id="u1", sender_name="user", thread_id=None,
                                              text=text, attachments=(), message_ref=ref))

        def until(predicate, timeout=60.0, message="condition not met"):
            deadline = time.monotonic() + timeout
            while not predicate():
                if time.monotonic() > deadline:
                    raise AssertionError(f"{message}; received: {received}")
                time.sleep(0.05)

        # 1) first message → full reply (after chunk merge)
        await inbound("m-1", "run a task for me")
        until(lambda: any("Gateway got the task" in text for text in received), message="first reply never arrived")

        # 2) /help takes effect immediately (control commands bypass the model)
        before = len(received)
        await inbound("m-2", "/help")
        until(lambda: len(received) > before and "Essentials:" in received[-1] or any("Essentials:" in text for text in received[before:]),
              message="/help did not reply")

        # 3) /status
        before = len(received)
        await inbound("m-3", "/status")
        until(lambda: len(received) > before, message="/status did not reply")

        pump_task.cancel()
        await asyncio.gather(pump_task, return_exceptions=True)
        await client.stop()

    asyncio.run(run())


# --- J9: CLI seat (one-shot subprocess) -------------------------------------------------


def test_j9_cli_one_shot_channel(worker_journey, model_server):
    model_server.script_text(["One-shot task done, exit code should be 0."], delay_ms=5)
    env = dict(os.environ)
    env.update({"RIND_HOME": str(worker_journey.home), "PYTHONUTF8": "1"})
    result = subprocess.run(
        ["node", str(PROJECT_ROOT / "frontend-cli" / "bin" / "rind.js"),
         "run", "--prompt", "run a one-shot task", "--dir", str(worker_journey.workspace)],
        cwd=worker_journey.root, env=env, capture_output=True, text=True, timeout=120,
        encoding="utf-8", errors="replace",
    )
    assert result.returncode == 0, f"one-shot exit code {result.returncode}; stderr: {result.stderr[-500:]}"
    assert "One-shot task done" in result.stdout, f"stdout missing the final reply: {result.stdout[-300:]}"
    assert model_server.request_count() >= 1, "CLI made no model request"
