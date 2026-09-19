"""File-tool ordering and cancellation through the production registry."""

import asyncio
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from agent.application.tools import ToolCallProcessor, ToolExecutor
from agent.domain import ParsedToolCall
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.events import ToolResultEvent
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.team import initialize_team_agent, initialize_team_project
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin.files import build_file_tool_specs, mutations
from agent.infrastructure.tools.builtin.files.queue import FileMutationQueue
from agent.runtime.server.worker import RuntimeWorker


def registry(root: Path, queue: FileMutationQueue | None = None) -> DefaultToolRegistry:
    return DefaultToolRegistry(build_file_tool_specs(root, mutation_queue=queue))


async def invoke(tools, name, **args):
    result = json.loads(await tools.call_async(name, args))
    assert result["ok"], result
    return result


@pytest_asyncio.fixture
async def blocked_stage(monkeypatch):
    started = asyncio.Event()
    release = threading.Event()
    staged = []
    original = mutations._stage_file
    loop = asyncio.get_running_loop()

    def stage(path, content, mode):
        staged.append((path, content))
        if len(staged) == 1:
            loop.call_soon_threadsafe(started.set)
            if not release.wait(10):
                raise TimeoutError("test did not release file operation")
        return original(path, content, mode)

    monkeypatch.setattr(mutations, "_stage_file", stage)
    yield started, release, staged
    release.set()


@pytest.mark.asyncio
async def test_same_batch_uses_latest_content_and_replay_does_not_repeat_writes(tmp_path):
    tools = registry(tmp_path)
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"))
    await store.initialize()
    await store.persist_message("user", "edit the file")
    operations = [
        ("write_file", {"content": "alpha\nbeta\n"}),
        ("edit_file", {"old_str": "alpha", "new_str": "ALPHA"}),
        ("edit_file", {"old_str": "beta", "new_str": "BETA"}),
        ("edit_file", {"old_str": "ALPHA", "new_str": "first"}),
        ("write_file", {"content": "replacement\n"}),
        ("write_file", {"content": "final\n"}),
        ("edit_file", {"old_str": "final", "new_str": "done"}),
    ]
    calls = [ParsedToolCall(call_id=f"call-{i}", name=name, raw_args=json.dumps({
        "file_path": "target.txt", **args,
    })) for i, (name, args) in enumerate(operations)]
    processor = ToolCallProcessor(ToolExecutor(tools))
    events = [event async for event in processor.execute(store, calls)]
    results = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(results) == len(calls)
    assert all(event.status == "completed" for event in results)
    assert (tmp_path / "target.txt").read_text() == "done\n"

    restored = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=store.session_id)
    await restored.initialize()
    (tmp_path / "target.txt").write_text("external change\n")
    events = [event async for event in processor.execute(restored, calls)]
    assert all(event.status == "completed" for event in events if isinstance(event, ToolResultEvent))
    assert (tmp_path / "target.txt").read_text() == "external change\n"


@pytest.mark.asyncio
async def test_historical_hash_arguments_are_ignored_by_registry(tmp_path):
    tools = registry(tmp_path)
    await invoke(tools, "write_file", file_path="old.txt", content="old", expected_sha256="stale")
    await invoke(tools, "edit_file", file_path="old.txt", old_str="old", new_str="new", expected_sha256="stale")
    assert (tmp_path / "old.txt").read_text() == "new"


@pytest.mark.asyncio
@pytest.mark.parametrize("alias", ["absolute", "parent", "case", "symlink"])
async def test_aliases_share_queue_and_unrelated_file_does_not_wait(tmp_path, blocked_stage, alias):
    started, release, staged = blocked_stage
    target = tmp_path / "target.txt"
    target.write_text("a b")
    alias_path = str(target)
    if alias == "parent":
        (tmp_path / "nested").mkdir()
        alias_path = "nested/../target.txt"
    elif alias == "case":
        if os.name != "nt":
            pytest.skip("case-insensitive Windows paths")
        alias_path = str(target).upper()
    elif alias == "symlink":
        link = tmp_path / "link.txt"
        try:
            link.symlink_to(target)
        except OSError:
            pytest.skip("symlinks unavailable")
        alias_path = str(link)
    queue = FileMutationQueue()
    first, second = registry(tmp_path, queue), registry(tmp_path, queue)
    tasks = [asyncio.create_task(invoke(first, "edit_file", file_path="target.txt", old_str="a", new_str="A"))]
    try:
        await asyncio.wait_for(started.wait(), 3)
        tasks.append(asyncio.create_task(invoke(second, "edit_file", file_path=alias_path, old_str="b", new_str="B")))
        await invoke(second, "write_file", file_path="other.txt", content="independent")
        assert len(staged) == 2
        assert not tasks[1].done()
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert target.read_text() == "A B"
    assert [content for path, content in staged if path.name == "target.txt"] == [b"A b", b"A B"]


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_task", [False, True])
async def test_cancelled_waiter_does_not_write_or_block_next_operation(tmp_path, blocked_stage, cancel_task):
    started, release, _ = blocked_stage
    tools = registry(tmp_path)
    source = CancellationTokenSource()
    first = asyncio.create_task(invoke(tools, "write_file", file_path="target.txt", content="first"))
    tasks = [first]
    try:
        await asyncio.wait_for(started.wait(), 3)
        waiter = asyncio.create_task(tools.call_async("write_file", {
            "file_path": "target.txt", "content": "cancelled", "_cancellation_token": source.token,
        }))
        tasks.append(waiter)
        await asyncio.sleep(0)
        if cancel_task:
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
        else:
            source.cancel("test cancellation")
            assert json.loads(await asyncio.wait_for(waiter, 3))["error_type"] == "Cancelled"
        tasks.append(asyncio.create_task(invoke(tools, "edit_file", file_path="target.txt", old_str="first", new_str="last")))
    finally:
        release.set()
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    assert not isinstance(outcomes[-1], BaseException)
    assert (tmp_path / "target.txt").read_text() == "last"


@pytest.mark.asyncio
async def test_task_cancellation_keeps_lock_until_filesystem_thread_stops(tmp_path, blocked_stage):
    started, release, staged = blocked_stage
    tools = registry(tmp_path)
    first = asyncio.create_task(invoke(tools, "write_file", file_path="target.txt", content="first"))
    tasks = [first]
    try:
        await asyncio.wait_for(started.wait(), 3)
        first.cancel()
        tasks.append(asyncio.create_task(invoke(tools, "edit_file", file_path="target.txt", old_str="first", new_str="last")))
        await invoke(tools, "write_file", file_path="other.txt", content="independent")
        assert not first.done() and not tasks[1].done()
        assert len(staged) == 2
    finally:
        release.set()
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    assert isinstance(outcomes[0], asyncio.CancelledError)
    assert not isinstance(outcomes[1], BaseException)
    assert (tmp_path / "target.txt").read_text() == "last"


@pytest.mark.asyncio
async def test_failure_releases_queue(tmp_path):
    queue = FileMutationQueue()

    def fail():
        raise OSError("test failure")

    with pytest.raises(OSError, match="test failure"):
        await queue.run(str(tmp_path / "target.txt"), fail, tool_name="write_file")
    tools = registry(tmp_path, queue)
    await invoke(tools, "write_file", file_path="target.txt", content="after failure")
    failure = json.loads(await tools.call_async("edit_file", {
        "file_path": "target.txt", "old_str": "missing", "new_str": "bad",
    }))
    assert failure["error_type"] == "OldStrNotFound"
    await invoke(tools, "edit_file", file_path="target.txt", old_str="after failure", new_str="recovered")


@pytest.mark.asyncio
async def test_worker_team_sessions_share_file_queue(tmp_path, monkeypatch, blocked_stage):
    started, release, staged = blocked_stage
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    (tmp_path / "team").mkdir()
    project = initialize_team_project(tmp_path / "team", project_id="queue-test")
    child = initialize_team_agent(project, agent_id="editor", description="Edit shared files")
    worker = RuntimeWorker(workspace_root=str(project.project_root / "agents" / "main-agent"))
    monkeypatch.setattr(worker.provider_service, "create_chat_client", AsyncMock(
        side_effect=lambda *args, **kwargs: SimpleNamespace(close=AsyncMock()),
    ))
    tasks = []
    try:
        parent_info = await worker.initialize()
        child_info = await worker.repository.create(
            str(child.workspace_root), parent_session_id=parent_info["session_id"], session_type="delegated_task",
        )
        parent_tools = (await worker.start_execution(parent_info["session_id"])).tool_registry
        child_tools = (await worker.start_execution(child_info["session_id"])).tool_registry
        tasks.append(asyncio.create_task(invoke(parent_tools, "write_file", file_path="shared/target.txt", content="parent")))
        await asyncio.wait_for(started.wait(), 3)
        tasks.append(asyncio.create_task(invoke(child_tools, "edit_file", file_path="shared/target.txt", old_str="parent", new_str="child")))
        await invoke(child_tools, "write_file", file_path="shared/other.txt", content="independent")
        assert len(staged) == 2 and not tasks[1].done()
    finally:
        release.set()
        try:
            await asyncio.gather(*tasks)
        finally:
            await worker.close()
    assert (project.shared_root / "target.txt").read_text() == "child"
