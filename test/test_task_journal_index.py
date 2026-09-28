import asyncio
import json
import os

import pytest

from agent.infrastructure.persistence.task_journal import TaskJournal
from test_shell_tasks import task_shell, data


def completed(index, **fields):
    return {"task_id": f"task_{index}", "status": "completed", "started_at": index,
            "origin_tool_call_id": f"call_{index}", "stdout": "x" * 2000, **fields}


def write_records(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


@pytest.mark.asyncio
async def test_hot_reads_are_incremental_across_workers_and_history_is_queryable(tmp_path, monkeypatch):
    path = tmp_path / "session" / "tasks.jsonl"
    write_records(path, [completed(i) for i in range(600)])
    first, second = TaskJournal(tmp_path), TaskJournal(tmp_path)
    try:
        assert not await first.relevant("session")
        assert len(first._tasks) == 256
        assert all("stdout" not in record for _, record in first._tasks.values())
        active = completed("live", status="running", worker_instance_id=second.worker_instance_id)
        await second.save("session", active, create=True)
        assert (await first.relevant("session"))["task_live"]["status"] == "running"
        def forbidden(*args, **kwargs):
            raise AssertionError("hot path scanned history")
        with monkeypatch.context() as patch:
            patch.setattr(first, "_all", forbidden)
            patch.setattr(first, "_find", forbidden)
            patch.setattr(first, "_scan_relevant", forbidden)
            for _ in range(5):
                assert "task_live" in await first.relevant("session")
                assert (await first.get("session", "task_live"))["stdout"] == active["stdout"]
                await first.update("session", "task_live", committed=True)
        await second.update("session", "task_live", status="completed", delivered=True)
        assert not await first.relevant("session")
        assert (await first.get("session", "task_0"))["origin_tool_call_id"] == "call_0"
        duplicate = await first.save("session", completed("duplicate", origin_tool_call_id="call_0"), create=True)
        assert duplicate["task_id"] == "task_0"
        assert len(await first.records("session")) == 601
        assert await first.get("other", "task_live") is None
    finally:
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_replacement_truncation_and_interrupted_append_invalidate_offsets(tmp_path):
    journal = TaskJournal(tmp_path)
    path = tmp_path / "session" / "tasks.jsonl"
    try:
        await journal.save("session", completed(0), create=True)
        replacement = path.with_suffix(".new")
        write_records(replacement, [completed(1)])
        os.replace(replacement, path)
        assert await journal.get("session", "task_0") is None
        assert (await journal.get("session", "task_1"))["task_id"] == "task_1"
        path.write_bytes(b'{"task_id":"task_2","status":"completed"}')
        assert (await journal.get("session", "task_2"))["status"] == "completed"
        await journal.save("session", completed(3), create=True)
        with path.open("ab") as output:
            output.write(b'{"task_id":')
        assert set(await journal.records("session")) == {"task_2", "task_3"}
        path.unlink()
        await journal.save("session", completed(4), create=True)
        assert set(await journal.records("session")) == {"task_4"}
        with path.open("ab") as output:
            output.write(b'invalid\n{}\n')
        with pytest.raises(ValueError, match="Corrupt"):
            await journal.relevant("session")
    finally:
        await journal.close()


@pytest.mark.asyncio
async def test_overflow_recovers_complete_relevant_index_and_bounds_sessions(tmp_path, monkeypatch):
    journal = TaskJournal(tmp_path)
    path = tmp_path / "session" / "tasks.jsonl"
    pending = [completed(i, handoff=True, notify="manual") for i in range(300)]
    write_records(path, pending)
    try:
        assert len(await journal.relevant("session")) == 300
        assert len(journal._tasks) == 256
        with path.open("a", encoding="utf-8") as output:
            for record in pending:
                output.write(json.dumps({**record, "delivered": True, "consumed": True}) + "\n")
        assert not await journal.relevant("session")
        with monkeypatch.context() as patch:
            patch.setattr(journal, "_scan_relevant", lambda *args: pytest.fail("overflow must not cause permanent scanning"))
            assert not await journal.relevant("session")
        for i in range(40):
            await journal.save(f"s{i}", completed(i), create=True)
        assert len(journal._sessions) == 32
        assert len(journal._tasks) <= 256
        assert all(sid in journal._sessions for sid, _ in journal._tasks)
        assert len(await journal.records("session")) == 300
    finally:
        await journal.close()


@pytest.mark.asyncio
async def test_failed_intent_never_spawns_or_accumulates_tasks(task_shell, monkeypatch):
    tools, processes = task_shell
    journal = tools.supervisor.journal
    original = journal._append
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(journal, "_append", fail)
    for i in range(12):
        assert not json.loads(await tools.bash("work", yield_time_ms=0, _idempotency_key=f"c{i}"))["ok"]
    assert not processes
    assert not tools.supervisor._processes
    monkeypatch.setattr(journal, "_append", original)
    assert data(await tools.bash("work", yield_time_ms=0))["status"] == "running"


@pytest.mark.asyncio
async def test_failed_terminal_write_blocks_new_start_but_allows_read_cancel_and_retry(task_shell, monkeypatch):
    tools, processes = task_shell
    first = data(await tools.bash("work", yield_time_ms=0))
    second = data(await tools.bash("work", yield_time_ms=0))
    journal = tools.supervisor.journal
    original = journal._append
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(journal, "_append", fail)
    processes[0].finish(stdout=b"finished")
    await tools.supervisor._processes[first["task_id"]].monitor
    for _ in range(12):
        result = json.loads(await tools.bash("blocked", yield_time_ms=0))
        assert result["error_type"] == "TaskPersistenceError"
    assert len(processes) == 2
    assert len(tools.supervisor._processes) == 2
    assert data(await tools.task_control("read", first["task_id"]))["stdout"] == "finished"
    assert data(await tools.task_control("cancel", second["task_id"]))["status"] == "cancelled"
    await tools.close_session("default")
    assert len(tools.supervisor._processes) == 2
    monkeypatch.setattr(journal, "_append", original)
    assert data(await tools.bash("resumed", yield_time_ms=0, _session_id="new"))["status"] == "running"
    assert (await journal.get("default", first["task_id"]))["stdout"] == "finished"
    assert (await journal.get("default", second["task_id"]))["status"] == "cancelled"
    assert len(processes) == 3


@pytest.mark.asyncio
async def test_interrupted_intent_finishes_persistence_without_spawning(task_shell, monkeypatch):
    tools, processes = task_shell
    journal = tools.supervisor.journal
    started, proceed = asyncio.Event(), asyncio.Event()
    original = journal.save

    async def delayed(session_id, snapshot, **kwargs):
        if kwargs.get("create"):
            started.set()
            await proceed.wait()
        return await original(session_id, snapshot, **kwargs)

    monkeypatch.setattr(journal, "save", delayed)
    call = asyncio.create_task(tools.bash("work", _idempotency_key="interrupt"))
    await started.wait()
    call.cancel()
    proceed.set()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert not processes
    records = await journal.records("default")
    assert len(records) == 1
    assert next(iter(records.values()))["status"] == "lost"
