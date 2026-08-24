from __future__ import annotations

import asyncio
import tempfile
from types import SimpleNamespace
from pathlib import Path

from agent.infrastructure.config import AppSettings
from agent.runtime.server.worker import RuntimeWorker
from agent.runtime.server.protocol import RuntimeMethod
from agent.runtime.server.stdio import WorkerStdioRuntimeServer


class _Event:
    def __init__(self, event_type: str, session_id: str, turn_id: str):
        self._data = {
            "type": event_type,
            "session_id": session_id,
            "turn_id": turn_id,
        }

    def to_dict(self):
        return dict(self._data)


class _Store:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.model = "test-model"
        self.session_root = "."
        self.workspace_root = "."

    async def initialize(self):
        return None

    async def get_messages_slice(self, start=None, end=None):
        return []

    async def get_turn_state(self):
        return {"status": "completed", "turn_id": ""}

    async def discard_if_empty(self):
        return None


class _Runtime:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.active_turn_id = ""

    @property
    def turn_active(self):
        return bool(self.active_turn_id)

    def set_user_question_responder(self, _responder):
        return None

    async def initialize(self):
        return None

    async def run_turn(self, *, cancellation_token, **_kwargs):
        turn_id = f"turn-{self.session_id}"
        self.active_turn_id = turn_id
        self.started.set()
        yield _Event("turn_started", self.session_id, turn_id)
        while not self.release.is_set() and not cancellation_token.is_cancelled:
            await asyncio.sleep(0)
        if cancellation_token.is_cancelled:
            self.cancelled.set()
            yield _Event("turn_cancelled", self.session_id, turn_id)
        else:
            yield _Event("turn_completed", self.session_id, turn_id)
        self.active_turn_id = ""


class _ExecutionContainer:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.workspace_root = "."
        self.session = _Store(session_id)
        self.runtime = _Runtime(session_id)

    @property
    def active_turn_id(self):
        return self.runtime.active_turn_id


class _ModelClient:
    def __init__(self):
        self.close_count = 0
        self.models = self

    def list(self):
        return _ModelList(("model-a", "model-b"))

    async def close(self):
        self.close_count += 1


class _ModelList:
    def __init__(self, values):
        self._values = iter(values)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return SimpleNamespace(id=next(self._values))
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _ProviderFactory:
    def __init__(self):
        self.create_count = 0

    def create_async_client(self):
        self.create_count += 1
        return _ModelClient()


class _Worker:
    def __init__(self):
        self.sessions = {session_id: _ExecutionContainer(session_id) for session_id in ("A", "B")}
        self.session_id = "A"
        self.default_model = "default-model"
        self.provider_client_factory = _ProviderFactory()
        self.model_client = _ModelClient()
        self.execution = _Execution(self)

    async def initialize(self):
        return {"session_id": "A", "model": self.default_model, "workspace_root": "."}

    async def start_execution(self, session_id: str):
        execution = self.sessions[session_id]
        return SimpleNamespace(runtime=execution.runtime, session_store=execution.session)

    async def release_execution(self, session_id: str):
        return None

    async def session(self, session_id: str):
        execution = self.sessions[session_id]
        return {"session_id": session_id, "model": execution.session.model, "workspace_root": "."}

    async def close(self):
        await self.model_client.close()


class _Execution:
    def __init__(self, worker):
        self.worker = worker
        self.tokens = {}

    def active_session_ids(self):
        return {
            session_id
            for session_id, execution in self.worker.sessions.items()
            if execution.runtime.turn_active
        }

    def active_turn_id(self, session_id):
        return self.worker.sessions[session_id].runtime.active_turn_id

    def interrupt(self, session_id, _reason=""):
        runtime = self.worker.sessions[session_id].runtime
        token = self.tokens.get(session_id)
        if not runtime.turn_active or token is None:
            return False
        token.is_cancelled = True
        return True

    async def run_turn(self, session_id, *, query, transient_system_messages=None, resume=False):
        execution = self.worker.sessions[session_id]
        token = type("Token", (), {"is_cancelled": False})()
        self.tokens[session_id] = token
        async for event in execution.runtime.run_turn(
            query=query,
            cancellation_token=token,
            transient_system_messages=transient_system_messages,
            resume=resume,
        ):
            yield event.to_dict()
        self.tokens.pop(session_id, None)

    def active_container(self, session_id):
        execution = self.worker.sessions.get(session_id)
        if execution is None or not execution.runtime.turn_active:
            return None
        return SimpleNamespace(runtime=execution.runtime, session_store=execution.session)


def _server_with_messages():
    worker = _Worker()
    server = WorkerStdioRuntimeServer(worker)
    messages = []

    async def send(payload):
        messages.append(payload)

    server._writer.send = send
    server._initialized = True
    return worker, server, messages


def test_worker_routes_concurrent_sessions_without_crossed_events():
    async def run():
        worker, server, messages = _server_with_messages()
        tasks = [
            asyncio.create_task(server._dispatch({
                "request_id": "prompt-A",
                "method": RuntimeMethod.SESSION_PROMPT,
                "params": {"session_id": "A", "input": "hello A"},
            })),
            asyncio.create_task(server._dispatch({
                "request_id": "prompt-B",
                "method": RuntimeMethod.SESSION_PROMPT,
                "params": {"session_id": "B", "input": "hello B"},
            })),
        ]
        await asyncio.gather(worker.sessions["A"].runtime.started.wait(), worker.sessions["B"].runtime.started.wait())
        worker.sessions["A"].runtime.release.set()
        worker.sessions["B"].runtime.release.set()
        await asyncio.gather(*tasks)
        return worker, messages

    worker, messages = asyncio.run(run())
    events = [message for message in messages if message.get("kind") == "event"]
    responses = {message["request_id"]: message for message in messages if message.get("kind") == "response"}

    assert {event["session_id"] for event in events} == {"A", "B"}
    assert all(event["turn_id"] == f"turn-{event['session_id']}" for event in events)
    assert responses["prompt-A"]["result"]["session_id"] == "A"
    assert responses["prompt-B"]["result"]["session_id"] == "B"
    assert worker.execution.active_session_ids() == set()


def test_worker_model_list_reuses_injected_client():
    async def run():
        worker, server, messages = _server_with_messages()
        await server._dispatch({"request_id": "models-1", "method": RuntimeMethod.MODEL_LIST, "params": {}})
        await server._dispatch({"request_id": "models-2", "method": RuntimeMethod.MODEL_LIST, "params": {}})
        return worker, messages

    worker, messages = asyncio.run(run())
    responses = [message for message in messages if message.get("kind") == "response"]
    assert len(responses) == 2
    assert worker.provider_client_factory.create_count == 0
    assert worker.model_client.close_count == 0


def test_compact_does_not_release_an_active_turn():
    async def run():
        worker, server, messages = _server_with_messages()
        prompt = asyncio.create_task(server._dispatch({
            "request_id": "prompt-A",
            "method": RuntimeMethod.SESSION_PROMPT,
            "params": {"session_id": "A", "input": "hello A"},
        }))
        await worker.sessions["A"].runtime.started.wait()
        await server._dispatch({
            "request_id": "compact-A",
            "method": RuntimeMethod.RIND_SESSION_COMPACT,
            "params": {"session_id": "A"},
        })
        still_active = worker.sessions["A"].runtime.turn_active
        worker.sessions["A"].runtime.release.set()
        await prompt
        return still_active, messages

    still_active, messages = asyncio.run(run())
    assert still_active
    compact = next(message for message in messages if message.get("request_id") == "compact-A")
    assert compact["error"]["type"] == "TurnActive"


def test_worker_shutdown_interrupts_all_active_sessions():
    async def run():
        worker, server, messages = _server_with_messages()
        serve_task = asyncio.create_task(server._serve())
        server._requests.put_nowait({
            "request_id": "prompt-A",
            "method": RuntimeMethod.SESSION_PROMPT,
            "params": {"session_id": "A", "input": "hello A"},
        })
        server._requests.put_nowait({
            "request_id": "prompt-B",
            "method": RuntimeMethod.SESSION_PROMPT,
            "params": {"session_id": "B", "input": "hello B"},
        })
        await asyncio.gather(worker.sessions["A"].runtime.started.wait(), worker.sessions["B"].runtime.started.wait())
        server._begin_shutdown({"request_id": "shutdown", "method": RuntimeMethod.SHUTDOWN})
        await asyncio.wait_for(serve_task, 2)
        return worker, messages

    worker, messages = asyncio.run(run())
    assert worker.sessions["A"].runtime.cancelled.is_set()
    assert worker.sessions["B"].runtime.cancelled.is_set()
    assert any(message.get("request_id") == "shutdown" and message.get("result") == {"ok": True} for message in messages)
    prompt_responses = {
        message["request_id"]: message
        for message in messages
        if message.get("kind") == "response" and message.get("request_id") in {"prompt-A", "prompt-B"}
    }
    assert set(prompt_responses) == {"prompt-A", "prompt-B"}
    assert worker.model_client.close_count == 1


def test_replay_does_not_create_active_execution():
    async def run():
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            settings = AppSettings(
                settings_path=root / "settings.json",
                settings_exists=True,
                model="test-model",
                api_key="test-key",
                base_url="https://example.com/v1",
                reasoning_effort="",
            )
            worker = RuntimeWorker(
                settings=settings,
                workspace_root=str(workspace),
                session_dir=str(root / "sessions"),
                enable_goal=False,
            )
            server = WorkerStdioRuntimeServer(worker)
            messages = []

            async def send(payload):
                messages.append(payload)

            server._writer.send = send
            await server._dispatch({"request_id": "init", "method": RuntimeMethod.INITIALIZE, "params": {}})
            session_id = worker.session_id
            await server._dispatch({
                "request_id": "replay",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": session_id},
            })
            active = worker.execution.active_session_ids()
            await worker.close()
            return session_id, active, messages

    session_id, active, messages = asyncio.run(run())
    assert session_id
    assert active == set()
    assert any(message.get("request_id") == "replay" for message in messages)


def test_worker_replay_includes_active_live_turn_without_creating_execution():
    async def run():
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            settings = AppSettings(
                settings_path=root / "settings.json",
                settings_exists=True,
                model="test-model",
                api_key="test-key",
                base_url="https://example.com/v1",
                reasoning_effort="",
            )
            worker = RuntimeWorker(
                settings=settings,
                workspace_root=str(workspace),
                session_dir=str(root / "sessions"),
                enable_goal=False,
            )
            await worker.initialize()
            session_id = worker.session_id
            worker.execution.update_live_event({
                "type": "turn_started",
                "session_id": session_id,
                "turn_id": "turn-live",
            })
            worker.execution.update_live_event({
                "type": "assistant_delta",
                "session_id": session_id,
                "turn_id": "turn-live",
                "text": "streaming",
            })
            replay = await worker.replay(session_id)
            active = worker.execution.active_session_ids()
            await worker.close()
            return replay, active

    replay, active = asyncio.run(run())
    assert replay["live_turn"]["turn_id"] == "turn-live"
    assert replay["live_turn"]["assistant_text"] == "streaming"
    assert active == set()
