import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from agent.domain.message_boundary import validate_model_message_boundary
from agent.application.task_notifications import TaskNotifications
from agent.domain.models import ModelStreamEvent
from agent.infrastructure.persistence import ToolOutputStore
from agent.infrastructure.tools.shell.tool import ShellTools
from agent.runtime.server.worker import RuntimeWorker
from test_shell_tasks import task_shell


class ScriptedClient:
    def __init__(self, steps, calls):
        self.steps = steps
        self.calls = calls
        self.closed = False

    async def stream(self, messages, **kwargs):
        assert validate_model_message_boundary(messages).ok
        self.calls.append(messages)
        step = self.steps.pop(0)
        if isinstance(step, dict):
            yield ModelStreamEvent(kind="tool_start", tool_call_id=step.get("id", "shell_call"), tool_name="bash")
            yield ModelStreamEvent(kind="tool_arguments_delta", tool_call_id=step.get("id", "shell_call"), arguments=json.dumps(step["args"]))
            yield ModelStreamEvent(kind="completed", stop_reason="tool_calls")
        else:
            yield ModelStreamEvent(kind="text_delta", text=step)
            yield ModelStreamEvent(kind="completed", stop_reason="stop")

    async def close(self):
        self.closed = True


async def worker_with_script(tmp_path, monkeypatch, task_shell, steps):
    tools, processes = task_shell
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    monkeypatch.setattr("agent.runtime.server.worker.ShellTools", lambda store: tools)
    worker = RuntimeWorker(workspace_root=str(tmp_path), session_dir=str(tmp_path / "sessions"), enable_goal=False)
    monkeypatch.setattr(worker.provider_service, "refresh_stale_models", AsyncMock())
    calls, clients = [], []

    async def create(*args, **kwargs):
        client = ScriptedClient(steps, calls)
        clients.append(client)
        return client

    monkeypatch.setattr(worker.provider_service, "create_chat_client", create)
    info = await worker.initialize()
    return worker, info["session_id"], processes, calls, clients


@pytest.mark.asyncio
async def test_idle_task_completion_reopens_client_and_finishes_request(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "work", "yield_time_ms": 0}}, "Waiting for work.", "Final answer."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        worker.execution.begin_request(sid)
        events = [event async for event in worker.execution.run_turn(sid, query="Build it")]
        assert events[-1]["type"] == "turn_completed", events[-1]
        summary = events[-1]["background_wait"]
        assert summary["count"] == 1
        assert (await worker.replay(sid))["background_wait"] == summary
        assert len(calls) == 2 and clients[0].closed
        assert not worker.execution.active_session_ids()
        waiting = asyncio.create_task(worker.execution.wait_request(sid))
        for _ in range(20):
            await asyncio.sleep(0)
        assert not waiting.done() and len(calls) == 2
        processes[0].finish(stdout=b"completed build\n")
        result = await asyncio.wait_for(waiting, 5)
        assert result["answer"] == "Final answer."
        assert await worker.execution.background_wait(sid) is None
        assert len(calls) == 3 and len(clients) == 2 and all(c.closed for c in clients)
        notifications = [m for m in calls[-1] if "runtime_notification" in m.get("content", "")]
        assert len(notifications) == 1 and notifications[0]["role"] == "user"
        assert "completed build" in notifications[0]["content"]
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_interrupted_idle_session_only_delivers_when_user_returns(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "work", "yield_time_ms": 0}}, "Waiting.", "Resumed answer."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        events = [event async for event in worker.execution.run_turn(sid, query="Build")]
        assert events[-1]["background_wait"]["count"] == 1
        cleared = asyncio.Event()
        worker.execution.add_event_sink(lambda event: cleared.set()
            if event["type"] == "background_wait_changed" and event["background_wait"] is None else None)
        assert worker.execution.interrupt(sid)
        await asyncio.wait_for(cleared.wait(), 2)
        assert processes[0].returncode is None
        assert (await worker.replay(sid))["background_wait"] is None
        processes[0].finish(stdout=b"late completion\n")
        task_id = (await worker.shell_tools.list_backgrounds(sid))[0]["task_id"]
        await worker.shell_tools.task_control("wait", task_id, _session_id=sid)
        assert len(calls) == 2
        _ = [event async for event in worker.execution.run_turn(sid, query="Continue")]
        assert len(calls) == 3
        assert any("late completion" in m.get("content", "") for m in calls[-1])
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_manual_service_does_not_block_request_or_start_model(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "server", "yield_time_ms": 0, "notify": "manual"}}, "Server managed until worker exits."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        worker.execution.begin_request(sid)
        events = [event async for event in worker.execution.run_turn(sid, query="Start service")]
        assert events[-1]["background_wait"] is None
        result = await asyncio.wait_for(worker.execution.wait_request(sid), 5)
        assert "Server managed" in result["answer"] and len(calls) == 2
        assert processes[0].returncode is None
    finally:
        await worker.close()
    assert processes[0].returncode == -9


@pytest.mark.asyncio
async def test_request_waits_for_tasks_started_by_continuation(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "first", "yield_time_ms": 0}}, "First waiting.",
             {"id": "second", "args": {"command": "second", "yield_time_ms": 0}}, "Second waiting.", "Both done."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        scope_id = worker.execution.begin_request(sid)
        _ = [event async for event in worker.execution.run_turn(sid, query="Two steps")]
        waiting = asyncio.create_task(worker.execution.wait_request(sid))
        processes[0].finish()
        async def second_started():
            while len(calls) < 4:
                await asyncio.sleep(0)
        await asyncio.wait_for(second_started(), 5)
        assert not waiting.done()
        processes[1].finish()
        result = await asyncio.wait_for(waiting, 5)
        assert result["answer"] == "Both done."
        tasks = await worker.shell_tools.supervisor.journal.records(sid)
        assert len(tasks) == 2 and all(t["request_id"] == scope_id for t in tasks.values())
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_background_wait_counts_only_committed_owned_on_exit_tasks(tmp_path, monkeypatch, task_shell):
    steps = [{"id": "first", "args": {"command": "first backtest", "yield_time_ms": 0}},
             {"id": "server", "args": {"command": "server", "yield_time_ms": 0, "notify": "manual"}},
             {"id": "second", "args": {"command": "second backtest", "yield_time_ms": 0}}, "Waiting."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        events = [event async for event in worker.execution.run_turn(sid, query="Run backtests")]
        summary = events[-1]["background_wait"]
        assert summary["count"] == 2
        raw = await worker.shell_tools.bash("uncommitted", yield_time_ms=0, _session_id=sid)
        assert json.loads(raw)["ok"]
        assert await worker.execution.background_wait(sid) == summary
        other = ShellTools(ToolOutputStore(str(tmp_path)))
        try:
            foreign = await other.bash("foreign task", yield_time_ms=0, _session_id=sid, _idempotency_key="foreign")
            await TaskNotifications(other.supervisor.journal).result_committed(sid, "bash", "foreign", foreign)
            assert await worker.execution.background_wait(sid) == summary
        finally:
            await other.close()
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_goal_waits_without_checkpoints_and_pause_wins_completion(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "work", "yield_time_ms": 0}}, "Waiting."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    goal = {"status": "active", "objective": "Build"}
    worker.execution._enable_goal = True
    monkeypatch.setattr(worker.repository, "get_goal", AsyncMock(side_effect=lambda sid: dict(goal)))
    try:
        _ = [event async for event in worker.execution.run_turn(sid, query="Build")]
        await worker.execution._continuations[sid]
        assert len(calls) == 2 and all(client.closed for client in clients)
        goal["status"] = "paused"
        assert await worker.execution.background_wait(sid) is None
        processes[0].finish()
        task_id = (await worker.shell_tools.list_backgrounds(sid))[0]["task_id"]
        await worker.shell_tools.task_control("wait", task_id, _session_id=sid)
        continuation = worker.execution._continuations.get(sid)
        if continuation:
            await continuation
        assert len(calls) == 2
        record = (await worker.shell_tools.supervisor.journal.records(sid))[task_id]
        assert not record["delivered"]
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_request_failure_keeps_notification_and_suppresses_retry(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "work", "yield_time_ms": 0}}, "Waiting."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        worker.execution.begin_request(sid)
        _ = [event async for event in worker.execution.run_turn(sid, query="Build")]
        processes[0].finish()
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(worker.execution.wait_request(sid), 5)
        assert len(calls) == 3
        record = next(iter((await worker.shell_tools.supervisor.journal.records(sid)).values()))
        assert record["delivered"] and not record.get("consumed")
        assert record["continuation_error"]
        assert not worker.execution._schedule_continuation(sid)
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_fork_does_not_copy_tasks_and_deletion_stops_future_starts(tmp_path, monkeypatch, task_shell):
    steps = [{"args": {"command": "work", "yield_time_ms": 0}}, "Waiting."]
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, steps)
    try:
        _ = [event async for event in worker.execution.run_turn(sid, query="Build")]
        fork = await worker.fork_session(sid)
        assert await worker.shell_tools.list_backgrounds(fork["session_id"]) == []
        assert processes[0].returncode is None
        await worker.delete_session(sid)
        assert processes[0].returncode is not None
        assert not await worker.shell_tools.supervisor.journal.records(fork["session_id"])
        result = json.loads(await worker.shell_tools.bash("again", _session_id=sid))
        assert not result["ok"] and len(processes) == 1
        with pytest.raises(RuntimeError):
            await worker.execution.start(sid)
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_bounded_event_queue_recovers_terminal_states_for_slow_client(tmp_path, monkeypatch, task_shell):
    worker, sid, processes, calls, clients = await worker_with_script(tmp_path, monkeypatch, task_shell, [])
    records = {f"task_{index}": {"task_id": f"task_{index}", "owner_session_id": sid, "status": "completed"}
               for index in range(200)}
    monkeypatch.setattr(worker.shell_tools.supervisor.journal, "records", AsyncMock(return_value=records))
    seen = set()
    def disconnected(event):
        raise RuntimeError("Client disconnected")
    worker.execution.add_event_sink(disconnected)
    worker.execution.add_event_sink(lambda event: seen.add(event["task"]["task_id"])
                                    if event["type"] == "task_updated" else None)
    try:
        for record in records.values():
            worker.execution.task_changed(record)
        assert len(worker.execution._task_events) == 128
        await worker.execution._task_event_pump
        assert seen == set(records)
        assert calls == []
    finally:
        await worker.close()
