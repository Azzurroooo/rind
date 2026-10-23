from __future__ import annotations
from agent.runtime.server.stdio import JsonlWriter

import asyncio
import pytest
import json
import shutil
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock
from pathlib import Path

from agent.infrastructure.settings import AppSettings
from agent.runtime.server.worker import RuntimeWorker
from agent.runtime.server.execution import ExecutionCoordinator
from agent.runtime.server.protocol import RuntimeMethod
from agent.runtime.server.dispatcher import RuntimeDispatcher


def test_execution_reads_configuration_once_and_refreshes_between_turns(tmp_path, monkeypatch):
    import agent.runtime.server.execution as worker_module
    from unittest.mock import AsyncMock

    async def run():
        monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
        worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
        await worker.initialize()
        info = await worker.create_conversation({})
        settings_loader = worker_module.load_settings
        reads = []

        def load():
            reads.append(True)
            return settings_loader()

        configurations = []

        async def create(settings, selection):
            configurations.append(settings)
            return SimpleNamespace(close=AsyncMock())

        monkeypatch.setattr(worker_module, "load_settings", load)
        monkeypatch.setattr(worker.provider_service, "create_chat_client", create)
        try:
            await worker.start_execution(info["session_id"])
            await worker.release_execution(info["session_id"])
            path = tmp_path / "home" / "settings.json"
            path.parent.mkdir(exist_ok=True)
            path.write_text(json.dumps({"model": "changed-model"}), encoding="utf-8")
            await worker.start_execution(info["session_id"])
            assert len(reads) == 2
            assert configurations[0].model != configurations[1].model
            assert configurations[1].model == "changed-model"
        finally:
            await worker.close()

    asyncio.run(run())


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

    async def get_messages_slice(self, start=None, end=None, compacted=True):
        return []

    async def get_turn_state(self):
        return {"status": "completed", "turn_id": ""}

    async def discard_if_empty(self):
        return None


class _Runtime:
    def discard_pending_inputs(self):
        return None

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


class _Worker:
    def __init__(self):
        self.sessions = {session_id: _ExecutionContainer(session_id) for session_id in ("A", "B")}
        self.session_id = "A"
        self.default_model = "default-model"
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
        return None


class _Execution:
    def add_event_sink(self, sink):
        return lambda: None

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
    server = RuntimeDispatcher(worker, writer=JsonlWriter())
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


def test_background_monitoring_survives_turn_execution_release():
    async def run():
        worker, server, messages = _server_with_messages()
        server._background_list = lambda session_id: [
            {"bg_id": "bg-1", "session_id": session_id, "status": "running"}
        ]
        server._background_output = lambda bg_id, *, max_output_chars, _session_id: {
            "bg_id": bg_id,
            "session_id": _session_id,
            "status": "running",
            "stdout": "tick",
            "max_output_chars": max_output_chars,
        }
        worker.sessions["A"].runtime.active_turn_id = ""

        await server._dispatch({
            "request_id": "background-list",
            "method": RuntimeMethod.RIND_BACKGROUND_LIST,
            "params": {"session_id": "A"},
        })
        await server._dispatch({
            "request_id": "background-output",
            "method": RuntimeMethod.RIND_BACKGROUND_OUTPUT,
            "params": {"session_id": "A", "bg_id": "bg-1", "max_output_chars": 100},
        })
        return messages

    messages = asyncio.run(run())
    responses = {
        message["request_id"]: message
        for message in messages
        if message.get("kind") == "response"
    }
    assert responses["background-list"]["result"] == {
        "tasks": [{"bg_id": "bg-1", "session_id": "A", "status": "running"}]
    }
    assert responses["background-output"]["result"]["task"] == {
        "bg_id": "bg-1",
        "session_id": "A",
        "status": "running",
        "stdout": "tick",
        "max_output_chars": 100,
    }


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
        serve_task = asyncio.create_task(server.serve())
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
                reasoning_effort="",
            )
            worker = RuntimeWorker(
                workspace_root=str(workspace),
                session_dir=str(root / "sessions"),
                enable_goal=False,
            )
            server = RuntimeDispatcher(worker, writer=JsonlWriter())
            messages = []

            async def send(payload):
                messages.append(payload)

            server._writer.send = send
            await server._dispatch({"request_id": "init", "method": RuntimeMethod.INITIALIZE, "params": {}})
            session_id = (await worker.create_conversation({}))["session_id"]
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
                reasoning_effort="",
            )
            worker = RuntimeWorker(
                workspace_root=str(workspace),
                session_dir=str(root / "sessions"),
                enable_goal=False,
            )
            await worker.initialize()
            session_id = (await worker.create_conversation({}))["session_id"]
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
            worker.execution.update_live_event({
                "type": "user_question_requested",
                "session_id": session_id,
                "turn_id": "turn-live",
                "tool_call_id": "call-question",
                "question": "Continue?",
                "options": [{"label": "yes", "description": "Continue"}],
            })
            worker.execution.update_live_event({
                "type": "tool_result",
                "session_id": session_id,
                "turn_id": "turn-live",
                "tool_call_id": "call-question",
                "tool_name": "ask_user_question",
                "status": "completed",
                "result": "{\"ok\":true}",
            })
            replay = await worker.replay(session_id)
            active = worker.execution.active_session_ids()
            question = worker.execution.live_turn(session_id)["question"]
            await worker.close()
            return replay, active, question

    replay, active, question = asyncio.run(run())
    assert replay["live_turn"]["turn_id"] == "turn-live"
    assert replay["live_turn"]["assistant_text"] == "streaming"
    assert question is None
    assert active == set()


def test_worker_replays_answer_received_before_question_responder_waits():
    async def run():
        execution = ExecutionCoordinator(
            shared_resources=SimpleNamespace(),
            shell_tools=SimpleNamespace(supervisor=SimpleNamespace(journal=SimpleNamespace(relevant=AsyncMock(return_value={})), set_observer=lambda callback: None)),
            web_sessions=SimpleNamespace(),
            repository=SimpleNamespace(),
            debug=False,
            enable_goal=False,
            enable_user_question=True,
            session_dir=None,
            provider_service=SimpleNamespace(),
        )
        container = SimpleNamespace()
        active = SimpleNamespace(container=container, pending_answers={})
        execution._active["session-a"] = active
        execution._prepare_user_question("session-a", "call-early")
        broadcast = []
        execution.add_event_sink(broadcast.append)
        await execution.answer_user_question("session-a", "call-early", "yes")
        with pytest.raises(LookupError, match="No pending user question"):
            await execution.answer_user_question("session-a", "call-early", "second answer")
        event = SimpleNamespace(tool_call_id="call-early")
        return await execution._answer_user_question("session-a", event), broadcast

    answer, broadcast = asyncio.run(run())
    assert answer == "yes"
    # Every window showing the session learns the question is settled, exactly once.
    assert broadcast == [{"type": "user_question_answered", "session_id": "session-a", "tool_call_id": "call-early", "answer": "yes"}]


def test_worker_goal_continuation_persists_distinct_checkpoints():
    async def run():
        class Repository:
            def __init__(self):
                self.goal = {"objective": "finish the release", "status": "active"}
                self.checkpoints = []

            async def get_goal(self, _session_id):
                return dict(self.goal)

            async def set_goal_status(self, status):
                self.goal["status"] = status
                return dict(self.goal)

        repository = Repository()

        class Store:
            async def persist_message(self, role, content, meta=None):
                repository.checkpoints.append({"role": role, "content": content, "meta": meta})

        class Execution(ExecutionCoordinator):
            async def start(self, _session_id):
                return SimpleNamespace(session_store=Store())

        execution = Execution(
            shared_resources=SimpleNamespace(),
            shell_tools=SimpleNamespace(supervisor=SimpleNamespace(journal=SimpleNamespace(relevant=AsyncMock(return_value={})), set_observer=lambda callback: None)),
            web_sessions=SimpleNamespace(),
            repository=repository,
            debug=False,
            enable_goal=True,
            enable_user_question=False,
            session_dir=None,
            provider_service=SimpleNamespace(),
        )
        turns = []
        events = []

        async def run_turn(_session_id, **kwargs):
            turn_id = f"turn-{len(turns) + 1}"
            turns.append(kwargs)
            if kwargs.get("checkpoint"):
                await Store().persist_message("user", kwargs["checkpoint"], meta={"kind": "goal_checkpoint"})
            events.append({"type": "turn_started", "session_id": "session-a", "turn_id": turn_id})
            yield events[-1]
            terminal = {"type": "turn_completed", "session_id": "session-a", "turn_id": turn_id}
            events.append(terminal)
            yield terminal
            if len(turns) == 2:
                repository.goal["status"] = "complete"

        async def sink(event):
            events.append(event)

        execution.run_turn = run_turn
        execution.add_event_sink(sink)
        started = await execution.start_goal_continuation("session-a")
        await next(iter(execution._continuations.values()))
        return started, turns, events, repository.goal, repository.checkpoints

    started, turns, events, goal, checkpoints = asyncio.run(run())
    assert started is True
    assert len(turns) == 2
    assert all(turn["query"] is None for turn in turns)
    assert all(turn["continuation"] is True for turn in turns)
    assert len(checkpoints) == 2
    assert all(item["role"] == "user" for item in checkpoints)
    assert all(item["meta"] == {"kind": "goal_checkpoint"} for item in checkpoints)
    assert all("finish the release" in item["content"] for item in checkpoints)
    assert [event["type"] for event in events if event["type"] == "turn_started"] == [
        "turn_started",
        "turn_started",
    ]
    assert goal["status"] == "complete"


def test_deleting_a_session_drops_its_tool_configuration(tmp_path, monkeypatch):
    async def run():
        monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
        worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
        await worker.initialize()
        try:
            session_id = (await worker.create_conversation({"enable_user_question": False}))["session_id"]
            assert worker.execution.owns_session(session_id)
            await worker.delete_session(session_id)
            assert not worker.execution.owns_session(session_id)
        finally:
            await worker.close()

    asyncio.run(run())


def test_app_server_rejects_interactive_tty_stdio(tmp_path, monkeypatch, capsys):
    from agent.runtime.server.app_server import async_main
    from agent.runtime.server.stdio import StdioRuntimeServer

    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    monkeypatch.setattr("sys.stdin", SimpleNamespace(isatty=lambda: True))
    code = asyncio.run(async_main(["--stdio", "--cwd", str(tmp_path)], server_class=StdioRuntimeServer))
    captured = capsys.readouterr()
    assert code == 1
    assert "cannot be run interactively in a terminal" in captured.err


def test_app_server_worker_lock_blocks_duplicate_worker_for_same_rind_home(tmp_path, monkeypatch, capsys):
    from agent.runtime.server.app_server import async_main
    from agent.runtime.server.stdio import StdioRuntimeServer
    from agent.runtime.server.worker_lock import acquire_worker_lock

    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("RIND_SHARED_HOST_PID", raising=False)
    monkeypatch.setattr("sys.stdin", SimpleNamespace(isatty=lambda: False))

    class _DummyWebServer:
        worker_mode = True
        network_mode = True

    lock = acquire_worker_lock()
    try:
        stdio_code = asyncio.run(async_main(["--stdio", "--cwd", str(tmp_path)], server_class=StdioRuntimeServer))
        web_code = asyncio.run(async_main(["--web", "--cwd", str(tmp_path)], server_class=_DummyWebServer))
    finally:
        lock.release()

    captured = capsys.readouterr()
    assert stdio_code == 1
    assert web_code == 1
    assert captured.err.count("Another Rind runtime worker is already running") == 2


def test_replay_end_zero_skips_store_and_refreshes_running_session_credentials(tmp_path, monkeypatch):
    import sys

    async def run():
        monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
        worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
        await worker.initialize()
        try:
            tool_v1 = {
                "command": sys.executable,
                "args": ["bridge.js"],
                "env": {"RIND_MANAGEMENT_TOKEN": "token-v1"},
                "lifecycle": {"before": "hostTurnStart", "after": "hostTurnEnd", "env": {"RIND_MANAGEMENT_TOKEN": "host-v1"}},
                "tools": [{"name": "delegate", "description": "d", "parameters": {"type": "object", "properties": {}}}],
                "instructions": "Team instructions",
            }
            created = await worker.create_conversation({"external_tools": tool_v1, "enable_user_question": False})
            session_id = created["session_id"]
            store = await worker.repository.open_store(session_id)
            await store.persist_message("user", "hello")
            await store.persist_turn_state("turn-1", "completed", "2026-10-15T12:00:00Z")

            # Simulate an active session while management restarts with rotated tokens and empty instructions on a managed session.
            worker.execution._active[session_id] = SimpleNamespace()
            worker.repository.exists = AsyncMock(side_effect=AssertionError("owned session should not check disk existence"))
            tool_v2 = {
                **tool_v1,
                "env": {"RIND_MANAGEMENT_TOKEN": "token-v2"},
                "lifecycle": {"before": "hostTurnStart", "after": "hostTurnEnd", "env": {"RIND_MANAGEMENT_TOKEN": "host-v2"}},
                "instructions": "",
            }
            await worker.configure_if_unowned(session_id, {"external_tools": tool_v2})
            refreshed = worker.execution.external_tool(session_id)
            assert refreshed.env["RIND_MANAGEMENT_TOKEN"] == "token-v2"
            assert refreshed.lifecycle["env"]["RIND_MANAGEMENT_TOKEN"] == "host-v2"
            assert refreshed.instructions == "Team instructions"
            assert worker.execution.user_question_enabled(session_id) is False

            # Same-host tool list and instruction changes update both _session_options and a live container's registry/runtime in place.
            from agent.infrastructure.tools import DefaultToolRegistry
            from agent.runtime.core.runtime import AgentRuntime
            live_registry = DefaultToolRegistry(worker.execution.external_tool(session_id).specs(session_id))
            live_runtime = AgentRuntime(
                turn_runner=SimpleNamespace(),
                session_store=store,
                runtime_system_messages=[{"role": "system", "content": "Team instructions", "_context_kind": "external_tools"}],
            )
            live_runtime._active_context_messages = [dict(m) for m in live_runtime._runtime_system_messages]
            worker.execution._active[session_id] = SimpleNamespace(
                container=SimpleNamespace(tool_registry=live_registry, runtime=live_runtime),
            )
            tool_v3 = {**tool_v2, "tools": [], "instructions": "Updated team roster"}
            await worker.configure_if_unowned(session_id, {"external_tools": tool_v3})
            assert worker.execution.external_tool(session_id).tools == ()
            assert live_registry.schemas == []
            assert not live_registry.has("delegate")
            assert live_runtime._runtime_system_messages[0]["content"] == "Updated team roster"
            assert live_runtime._active_context_messages[0]["content"] == "Updated team roster"

            # Opening a persisted store and projecting messages reads messages.jsonl once via _messages_cache.
            from agent.infrastructure.persistence.message_repository import MessageRepository
            reads = 0
            original_load = MessageRepository.load_messages

            def counting_load(self_repo):
                nonlocal reads
                reads += 1
                return original_load(self_repo)

            monkeypatch.setattr(MessageRepository, "load_messages", counting_load)
            reopened = await worker.repository.open_store(session_id, persist_system_prompt=False)
            sliced = await reopened.get_messages_slice(include_ids=True, compacted=False)
            assert len(sliced) == 2
            assert reads == 1

            # Metadata-only replay(end=0) must not open JsonlSessionStore or scan shell tasks.
            worker.repository._open_store_from_info = AsyncMock(side_effect=AssertionError("should not open store"))
            worker.shell_tools.maintain_tasks = AsyncMock(side_effect=AssertionError("should not maintain tasks"))
            worker.shell_tools.monitor_tasks = AsyncMock(side_effect=AssertionError("should not monitor tasks"))
            meta = await worker.replay(session_id, end=0)
            assert meta["messages"] == []
            assert meta["message_total"] == 2
            assert meta["turn_state"]["status"] == "completed"
            assert meta["hosted"] is True
            assert meta["tasks"] == []
        finally:
            worker.execution._active.clear()
            await worker.close()

    asyncio.run(run())


def test_semaphore_queued_turn_is_visible_steerable_cancellable_and_orders_after_hook(tmp_path, monkeypatch):
    import sys
    from agent.domain.models import ModelStreamEvent
    from agent.infrastructure.tools.external import ExternalTool

    async def run():
        monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
        worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"))
        await worker.initialize()
        try:
            worker.execution._turn_semaphore = asyncio.Semaphore(1)
            await worker.execution._turn_semaphore.acquire()

            after_entered = asyncio.Event()
            release_after = asyncio.Event()
            seen_prompts = []

            async def fake_notify(self_tool, phase, session_id, parameters, cancellation_token=None):
                if phase == "after":
                    after_entered.set()
                    await release_after.wait()

            monkeypatch.setattr(ExternalTool, "notify", fake_notify)

            async def fake_create_client(*_args, **_kwargs):
                async def stream(*, messages, **_kw):
                    user_texts = [m.get("content") for m in messages if m.get("role") == "user"]
                    seen_prompts.append(user_texts)
                    yield ModelStreamEvent(kind="text_delta", text="done")
                    yield ModelStreamEvent(kind="completed", stop_reason="stop")

                return SimpleNamespace(stream=stream, close=AsyncMock())

            monkeypatch.setattr(worker.provider_service, "create_chat_client", fake_create_client)

            tool_cfg = {
                "command": sys.executable,
                "args": ["bridge.js"],
                "env": {},
                "lifecycle": {"before": "hostTurnStart", "after": "hostTurnEnd", "env": {}},
                "tools": [],
            }
            s1 = (await worker.create_conversation({"external_tools": tool_cfg, "enable_user_question": False}))["session_id"]
            s2 = (await worker.create_conversation({"external_tools": tool_cfg, "enable_user_question": False}))["session_id"]

            # 1. Start s1 while semaphore is saturated: turn_started emits immediately, live_turn is running,
            #    and cancelling aborts the semaphore wait without needing a slot.
            s1_events = []
            s1_started = asyncio.Event()

            async def consume_s1():
                async for ev in worker.execution.run_turn(s1, query="queued cancel test"):
                    s1_events.append(ev)
                    if ev.get("type") == "turn_started":
                        s1_started.set()

            t1 = asyncio.create_task(consume_s1())
            await asyncio.wait_for(s1_started.wait(), timeout=2.0)
            assert worker.execution.live_turn(s1)["status"] == "running"
            assert worker.execution.active_turn_id(s1) != ""

            release_after.set()
            worker.execution.interrupt(s1, "User interrupted")
            await asyncio.wait_for(t1, timeout=2.0)
            assert [e["type"] for e in s1_events] == ["turn_started", "turn_cancelled"]
            assert (await worker.replay(s1, end=0))["turn_state"]["status"] == "cancelled"

            # 2. Start s2 while semaphore is still saturated: steer into it via dispatcher's auto-steer
            #    on session/prompt, then release semaphore and verify notify("after") ordering.
            release_after.clear()
            after_entered.clear()
            server = RuntimeDispatcher(worker, writer=JsonlWriter())
            messages = []

            async def send(payload):
                messages.append(payload)

            server._writer.send = send
            server._initialized = True

            s2_started = asyncio.Event()
            orig_send_event = server._send_event

            async def tracked_send_event(event):
                await orig_send_event(event)
                if event.get("session_id") == s2 and event.get("type") == "turn_started":
                    s2_started.set()

            server._send_event = tracked_send_event

            prompt_task = asyncio.create_task(server._dispatch({
                "request_id": "p-initial",
                "method": RuntimeMethod.SESSION_PROMPT,
                "params": {"session_id": s2, "input": "initial question"},
            }))
            await asyncio.wait_for(s2_started.wait(), timeout=2.0)
            assert worker.execution.live_turn(s2)["status"] == "running"

            # Sending another interactive session/prompt while active auto-converts to steering.
            await server._dispatch({
                "request_id": "p-auto-steer",
                "method": RuntimeMethod.SESSION_PROMPT,
                "params": {"session_id": s2, "input": "steered while queued"},
            })
            responses = {m["request_id"]: m for m in messages if m.get("kind") == "response"}
            assert responses["p-auto-steer"]["result"]["steered"] is True
            assert len(worker.execution.live_turn(s2)["pending_inputs"]) == 1

            # Release semaphore slot: LLM runs with steered input, then blocks in notify("after").
            worker.execution._turn_semaphore.release()
            await asyncio.wait_for(after_entered.wait(), timeout=2.0)

            # While notify("after") is still running, turn_completed has NOT been emitted yet!
            emitted_types = [m["event"]["type"] for m in messages if m.get("kind") == "event" and m.get("session_id") == s2]
            assert "turn_completed" not in emitted_types
            assert worker.execution.live_turn(s2)["status"] == "running"

            release_after.set()
            await asyncio.wait_for(prompt_task, timeout=2.0)
            emitted_types = [m["event"]["type"] for m in messages if m.get("kind") == "event" and m.get("session_id") == s2]
            assert emitted_types[-1] == "turn_completed"
            assert (await worker.replay(s2, end=0))["turn_state"]["status"] == "completed"
            assert any("steered while queued" in str(batch) for batch in seen_prompts)
        finally:
            await worker.close()

    asyncio.run(run())


