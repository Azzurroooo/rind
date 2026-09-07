"""In-memory fake rind worker: shared test scaffold with an injectable event
stream (``push_event``/``run_turn``); served over stdio or embedded in-process."""

from __future__ import annotations

import asyncio
import json
import sys

WORKER_CAPABILITY = "rind/session-subscriptions"
DURABLE_EVENT_TYPES = frozenset({"turn_started", "assistant_message_completed", "tool_requested",
                                 "tool_result", "turn_completed", "turn_failed", "turn_cancelled"})
TERMINAL_EVENT_TYPES = frozenset({"turn_completed", "turn_failed", "turn_cancelled"})


class FakeSession:
    __slots__ = ("session_id", "events", "turn_id", "turns", "terminal")

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.events: list[dict] = []  # durable log; len(events) is the replay cursor
        self.turn_id = ""
        self.turns = 0
        self.terminal: asyncio.Future | None = None

    def next_turn(self) -> str:
        self.turns += 1
        self.turn_id = f"turn-{self.turns}"
        return self.turn_id


class FakeConnection:
    """One client-facing JSONL connection (subscription set + sequence)."""

    def __init__(self, worker: "FakeWorker") -> None:
        self._worker = worker
        self.subscriptions: set[str] = set()
        self._sequence = 0
        self._outbound: asyncio.Queue[dict] = asyncio.Queue()

    def receive(self, payload: dict) -> None:
        asyncio.get_running_loop().create_task(self._worker.dispatch(self, payload))

    def send(self, payload: dict) -> None:
        self._outbound.put_nowait(payload)

    def drain(self) -> list[dict]:
        """All queued outbound frames, in order (used by the stdio loop)."""
        items: list[dict] = []
        while not self._outbound.empty():
            items.append(self._outbound.get_nowait())
        return items

    def next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    async def recv(self) -> dict:
        return await self._outbound.get()


class FakeWorker:
    def __init__(self, *, capabilities: list[str] | None = None, stall_methods: tuple[str, ...] = ()) -> None:
        self.capabilities = list(capabilities if capabilities is not None else [WORKER_CAPABILITY, "sessions", "models"])
        self.stall_methods = set(stall_methods)
        self.stalled: dict[str, asyncio.Future] = {}
        self.created: list[dict] = []
        self.prompts: list[tuple[str, str]] = []
        self.follow_ups: list[tuple[str | None, str]] = []
        self.answers: list[tuple[str | None, str, str]] = []
        self.cancels: list[str | None] = []
        self.compacts: list[str | None] = []
        self.sessions: dict[str, FakeSession] = {}
        self._connections: list[FakeConnection] = []
        self._counter = 0

    # --- scaffolding API (tests) ---------------------------------------------

    def open_connection(self) -> FakeConnection:
        connection = FakeConnection(self)
        self._connections.append(connection)
        return connection

    def new_session(self) -> str:
        self._counter += 1
        session_id = f"fake-{self._counter:04d}"
        self.sessions[session_id] = FakeSession(session_id)
        return session_id

    def push_event(self, session_id: str, event: dict) -> None:
        session = self.sessions[session_id]
        if event.get("type") in DURABLE_EVENT_TYPES:
            session.events.append(dict(event))
        for connection in self._connections:
            if session_id in connection.subscriptions:
                connection.send(self._envelope(connection, session, event))
        if event.get("type") in TERMINAL_EVENT_TYPES and session.terminal is not None and not session.terminal.done():
            session.terminal.set_result(event)

    async def run_turn(self, session_id: str, events: list[dict]) -> None:
        self.sessions[session_id].next_turn()
        for event in events:
            self.push_event(session_id, event)
            await asyncio.sleep(0)

    # --- JSONL method surface -------------------------------------------------

    async def dispatch(self, connection: FakeConnection, request: dict) -> None:
        method = str(request.get("method") or "")
        params = request.get("params") or {}
        try:
            if method in self.stall_methods:
                self.stalled[method] = asyncio.get_running_loop().create_future()
                await self.stalled[method]
            result = await self._handle(connection, method, params)
            connection.send({"kind": "response", "request_id": request.get("request_id"), "result": result})
        except Exception as exc:  # noqa: BLE001 - surfaced as a protocol error envelope
            connection.send({"kind": "response", "request_id": request.get("request_id"),
                             "error": {"type": type(exc).__name__, "message": str(exc)}})

    async def _handle(self, connection: FakeConnection, method: str, params: dict) -> dict:
        if method == "initialize":
            first = next(iter(self.sessions), None)
            return {"protocol_version": "2", "version": "fake-worker", "capabilities": self.capabilities, "session_id": first}
        if method == "session/new":
            self.created.append(dict(params))
            session_id = self.new_session()
            connection.subscriptions.add(session_id)
            return {"session_id": session_id, "draft": False, "workspace_root": params.get("workspace_root")}
        if method == "session/subscribe":
            connection.subscriptions.add(str(params.get("session_id")))
            return {"ok": True, "subscribed": sorted(connection.subscriptions)}
        if method == "session/unsubscribe":
            connection.subscriptions.discard(str(params.get("session_id")))
            return {"ok": True, "subscribed": sorted(connection.subscriptions)}
        if method == "session/prompt":
            return await self._prompt(connection, params)
        if method == "session/cancel":
            self.cancels.append(params.get("session_id"))
            session = self.sessions.get(str(params.get("session_id") or ""))
            if session is not None and session.terminal is not None and not session.terminal.done():
                self.push_event(session.session_id, {"type": "turn_cancelled", "reason": "user"})
            return {"ok": True}
        if method == "rind/session/follow_up":
            self.follow_ups.append((params.get("session_id"), str(params.get("input") or "")))
            return {"ok": True, "input_id": f"fu-{len(self.follow_ups)}"}
        if method == "rind/user-question/respond":
            answer = (params.get("session_id"), str(params.get("tool_call_id") or ""), str(params.get("answer") or ""))
            self.answers.append(answer)
            return {"ok": True}
        if method == "rind/session/compact":
            self.compacts.append(params.get("session_id"))
            return {"ok": True}
        if method == "session/replay":
            session = self.sessions[str(params.get("session_id") or "")]
            after = max(0, int(params.get("after_cursor") or 0))
            envelopes = [{"kind": "event", "method": "session/update", "sequence": after + index + 1,
                          "durability": "durable", "session_id": session.session_id, "turn_id": session.turn_id,
                          "event": dict(event)}
                         for index, event in enumerate(session.events[after:])]
            return {"events": envelopes, "cursor": len(session.events)}
        return {"ok": True}

    async def _prompt(self, connection: FakeConnection, params: dict) -> dict:
        session_id = str(params.get("session_id") or next(iter(self.sessions)))
        session = self.sessions[session_id]
        self.prompts.append((session_id, str(params.get("input") or params.get("query") or "")))
        connection.subscriptions.add(session_id)
        session.next_turn()
        session.terminal = asyncio.get_running_loop().create_future()
        await session.terminal
        session.terminal = None
        return {"ok": True, "session_id": session_id, "turn_id": session.turn_id}

    def _envelope(self, connection: FakeConnection, session: FakeSession, event: dict) -> dict:
        return {"kind": "event", "method": "session/update", "sequence": connection.next_sequence(),
                "durability": "durable" if event.get("type") in DURABLE_EVENT_TYPES else "incremental",
                "session_id": session.session_id, "turn_id": session.turn_id, "event": dict(event)}


async def serve_stdio(worker: FakeWorker | None = None) -> None:
    """Serve one FakeWorker over stdin/stdout JSONL (same surface as WS)."""
    worker = worker or FakeWorker()
    connection = worker.open_connection()
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(request, dict):
            await worker.dispatch(connection, request)
            for payload in connection.drain():  # responses and events, in order
                sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(serve_stdio()) or 0)
