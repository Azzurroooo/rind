"""Configurable worker fake for StdioRuntimeServer protocol tests."""

from __future__ import annotations

import asyncio
from typing import Any


class FakeStore:
    def __init__(self, worker, session_id: str):
        self.worker = worker
        self.session_id = session_id
        self.workspace_root = worker.workspace_root
        self.provider = worker.sessions.get(session_id, {}).get("provider", "")
        self.model = worker.sessions.get(session_id, {}).get("model", "")
        self.updates: list[tuple[str, str]] = []
        self.reasoning_efforts: list[str] = []

    async def update_selection(self, provider: str, model: str) -> None:
        self.updates.append((provider, model))
        self.provider = provider
        self.model = model

    async def update_reasoning_effort(self, effort: str) -> None:
        self.reasoning_efforts.append(effort)


class FakeRuntime:
    def __init__(self, turn_active: bool = False):
        self._turn_active = turn_active

    @property
    def turn_active(self) -> bool:
        return self._turn_active


class FakeContainer:
    def __init__(self, store: FakeStore, runtime: FakeRuntime):
        self.session_store = store
        self.runtime = runtime


class FakeExecution:
    def __init__(self, worker):
        self.worker = worker
        self.sinks = []
        self.queries: list[dict] = []
        self.submitted: list[tuple] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.blocking = False
        self.interrupted: list[str] = []
        self.active_turn_ids: dict[str, str] = {}

    def add_event_sink(self, sink):
        self.sinks.append(sink)
        return lambda: self.sinks.remove(sink)

    def active_session_ids(self) -> set[str]:
        return set(self.worker.sessions)

    def active_container(self, session_id: str):
        container = self.worker.containers.get(session_id)
        return container

    def active_turn_id(self, session_id: str) -> str:
        return self.active_turn_ids.get(session_id, "")

    def interrupt(self, session_id: str, reason: str = "interrupted") -> bool:
        self.interrupted.append(session_id)
        self.release.set()
        return True

    async def run_turn(self, session_id: str, *, query=None, transient_system_messages=None, resume=False):
        self.queries.append({"session_id": session_id, "query": query, "resume": resume})
        if self.blocking:
            self.started.set()
            await self.release.wait()
        yield {"type": "turn_started", "session_id": session_id, "turn_id": "t1"}
        yield {"type": "turn_completed", "session_id": session_id, "turn_id": "t1"}

    def submit_input(self, session_id: str, mode: str, text: str) -> dict:
        if session_id not in self.worker.sessions:
            raise RuntimeError("Session execution is not active.")
        if getattr(self, "input_queue_error", None) is not None:
            raise self.input_queue_error
        self.submitted.append(("submit", mode, text))
        return {"accepted": True, "input_id": f"{mode}-1", "mode": mode, "pending": 1}

    def retrieve_input(self, session_id: str, mode: str, input_id=None) -> dict:
        self.submitted.append(("retrieve", mode, input_id))
        return {"retrieved": True, "input_id": f"{mode}-1", "input": "queued text", "mode": mode, "pending": 0}

    def promote_follow_up(self, session_id: str, input_id: str) -> dict:
        self.submitted.append(("promote", "follow_up", input_id))
        return {"accepted": True, "input_id": input_id, "mode": "steering", "pending": 1}

    async def answer_user_question(self, session_id: str, tool_call_id: str, answer: str) -> None:
        if tool_call_id not in self.worker.pending_questions:
            raise LookupError("No pending user question.")
        self.worker.pending_questions[tool_call_id] = answer


class FakeRepository:
    def __init__(self, worker):
        self.worker = worker

    async def info(self, session_id: str) -> dict:
        if session_id not in self.worker.sessions:
            raise LookupError(session_id)
        return {
            "session_id": session_id,
            "model": self.worker.sessions[session_id].get("model", ""),
            "provider": self.worker.sessions[session_id].get("provider", ""),
            "reasoning_effort": "",
            "workspace_root": self.worker.workspace_root,
        }

    async def list(self, limit=20, workspace_root=None) -> list[dict]:
        return [{"id": session_id, "title": f"session {session_id}"} for session_id in self.worker.sessions][:limit]

    async def replay(self, session_id, start=None, end=None) -> dict:
        return {"messages": self.worker.messages, "turn_state": None, "session_id": session_id, "model": "m1"}

    async def replay_event_pages(self, session_id) -> dict:
        return {
            "messages": list(self.worker.messages),
            "tool_records": list(self.worker.tool_records),
            "turn_state": self.worker.turn_state,
            "session_id": session_id,
        }

    async def open_store(self, session_id, workspace_root=None, *, persist_system_prompt=True) -> FakeStore:
        if session_id not in self.worker.sessions:
            raise LookupError(session_id)
        return self.worker.stores.setdefault(session_id, FakeStore(self.worker, session_id))

    async def get_goal(self, session_id):
        return self.worker.goal

    async def set_goal(self, session_id, objective):
        self.worker.goal = {"objective": objective, "status": "active"}
        return dict(self.worker.goal)

    async def set_goal_status(self, session_id, status):
        if isinstance(self.worker.goal, dict):
            self.worker.goal["status"] = status
        return dict(self.worker.goal) if isinstance(self.worker.goal, dict) else self.worker.goal

    async def clear_goal(self, session_id):
        self.worker.goal = None


class FakeWorker:
    """Worker double covering the StdioRuntimeServer surface."""

    def __init__(self, workspace_root: str = "."):
        self.workspace_root = workspace_root
        self.session_id = "s1"
        self.sessions: dict[str, dict] = {"s1": {"model": "m1", "provider": "p1"}}
        self.stores: dict[str, FakeStore] = {}
        self.containers: dict[str, FakeContainer] = {}
        self.messages: list[dict] = []
        self.tool_records: list[dict] = []
        self.turn_state: dict | None = None
        self.goal = None
        self.pending_questions: dict[str, str] = {}
        self.models_listing = {"models": [], "warning": None}
        self.providers: list[dict] = []
        self.execution = FakeExecution(self)
        self.repository = FakeRepository(self)

    def list_providers(self, workspace_root=None) -> list[dict]:
        return self.providers

    async def list_models(self, workspace_root=None, *, refresh=False) -> dict:
        return self.models_listing

    async def initialize(self) -> dict:
        return {
            "session_id": self.session_id,
            "model": "m1",
            "provider": "p1",
            "reasoning_effort": "",
            "workspace_root": self.workspace_root,
            "message_count": len(self.messages),
            "goal": self.goal,
            "live_turn": None,
            "turn_state": None,
        }

    async def session(self, session_id: str) -> dict:
        return await self.repository.info(session_id)

    async def create_session(self, workspace_root=None) -> dict:
        return {"session_id": "new-session", "model": "m2", "provider": "p1", "workspace_root": workspace_root or self.workspace_root}

    async def replay(self, session_id, start=None, end=None) -> dict:
        return await self.repository.replay(session_id, start, end)

    async def replay_event_pages(self, session_id) -> dict:
        return await self.repository.replay_event_pages(session_id)

    async def usage_summary(self, days=7) -> dict:
        return {"days": days}

    async def login(self, provider_id, method, interaction) -> None:
        self.login_prompt = await interaction.prompt("secret", f"{provider_id} API key")

    def logout(self, provider_id) -> bool:
        return True

    async def close(self) -> None:
        return None


class _CaptureWriter:
    def __init__(self):
        self.payloads: list[dict] = []

    async def send(self, payload: dict) -> None:
        self.payloads.append(payload)

    def close(self) -> None:
        return None


def make_server(worker: FakeWorker) -> tuple:
    from agent.runtime.server.dispatcher import RuntimeDispatcher

    writer = _CaptureWriter()
    server = RuntimeDispatcher(worker, writer=writer)
    server._initialized = True
    return server, writer.payloads
