import asyncio
import json

import pytest

from agent.infrastructure.persistence.task_journal import TaskJournal
from agent.infrastructure.persistence.task_output import TaskOutput, encode_cursor
from agent.infrastructure.persistence import ToolOutputStore
from agent.infrastructure.tools.shell.tool import ShellTools
from test_shell_tasks import task_shell, data


@pytest.mark.asyncio
async def test_live_worker_is_not_adopted_and_restart_marks_lost(tmp_path):
    first = TaskJournal(tmp_path)
    second = TaskJournal(tmp_path)
    intent = {"task_id": "task_a", "origin_tool_call_id": "call_a", "owner_session_id": "session",
        "status": "starting", "worker_instance_id": first.worker_instance_id, "started_at": 1}
    try:
        await first.save("session", intent, create=True)
        assert (await second.records("session"))["task_a"]["status"] == "starting"
        await first.close()
        recovered = (await second.records("session"))["task_a"]
        assert recovered["status"] == "lost" and recovered["exit_code"] is None
        same = await second.save("session", {**intent, "task_id": "task_new"}, create=True)
        assert same["task_id"] == "task_a" and same["status"] == "lost"
    finally:
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_interrupted_final_append_preserves_command_deduplication(tmp_path):
    journal = TaskJournal(tmp_path)
    await journal.save("session", {"task_id": "task_a", "status": "completed", "origin_tool_call_id": "call_a"})
    with (tmp_path / "session" / "tasks.jsonl").open("ab") as stream:
        stream.write(b'{"task_id":')
    assert list(await journal.records("session")) == ["task_a"]
    await journal.update("session", "task_a", delivered=True)
    assert (await journal.records("session"))["task_a"]["delivered"] is True
    await journal.close()


@pytest.mark.asyncio
async def test_independent_cursors_preserve_unicode_streams_and_capture_order(tmp_path):
    output = TaskOutput(tmp_path / "out.txt", "task_a")
    await output.start()
    await output.append("stdout", "一\r\x1b[31m二".encode(), "一\r\x1b[31m二")
    await output.append("stderr", "错\n".encode(), "错\n")
    await output.close()
    start = encode_cursor("task_a", 0)
    first = await output.read(start, 2)
    assert first["stdout"] == "一\r"
    assert await output.read(start, 2) == first
    cursor = first["next_cursor"]
    stdout, stderr = first["stdout"], ""
    for _ in range(20):
        page = await output.read(cursor, 2)
        stdout += page["stdout"]
        stderr += page["stderr"]
        cursor = page["next_cursor"]
        if not page["truncated"]:
            break
    assert stdout == "一\r\x1b[31m二" and stderr == "错\n"
    assert output.path.read_bytes() == "一\r\x1b[31m二错\n".encode()
    with pytest.raises(ValueError, match="Invalid cursor"):
        await output.read(encode_cursor("task_other", 0), 20)


@pytest.mark.asyncio
@pytest.mark.parametrize("disk_failure", [False, True])
async def test_output_quota_or_write_failure_keeps_drain_alive(tmp_path, monkeypatch, disk_failure):
    output = TaskOutput(tmp_path / "out.txt", "task_a", max_bytes=200)
    await output.start()
    if disk_failure:
        def fail(batch):
            raise OSError("disk full")
        monkeypatch.setattr(output, "_write_batch", fail)
    for _ in range(100):
        await output.append("stdout", b"x" * 1024, "x" * 1024)
    await asyncio.wait_for(output.close(), 2)
    assert output.incomplete
    assert output.path.stat().st_size <= 200


@pytest.mark.asyncio
async def test_completed_task_survives_new_worker_without_respawn(task_shell, tmp_path):
    tools, processes = task_shell
    result = data(await tools.bash("work", yield_time_ms=0, _idempotency_key="once"))
    processes[0].finish(stdout=b"end\n")
    await tools.task_control("wait", result["task_id"])
    await tools.close()
    replacement = ShellTools(ToolOutputStore(str(tmp_path)))
    try:
        recovered = data(await replacement.bash("work", yield_time_ms=0, _idempotency_key="once"))
        assert recovered["task_id"] == result["task_id"] and recovered["status"] == "completed"
        assert len(processes) == 1
        page = data(await replacement.task_control("read", result["task_id"], cursor=result["start_cursor"], max_output_chars=2))
        assert page["stdout"] == "en"
        assert data(await replacement.task_control("read", result["task_id"], cursor=page["next_cursor"]))["stdout"] == "d\n"
    finally:
        await replacement.close()
