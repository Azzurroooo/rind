import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import ToolResultNormalizer


class MemoryOutputStore:
    def __init__(self, root: Path):
        self.root = root
        self.calls: list[tuple[str, str]] = []

    async def write(self, session_id: str, call_id: str, content: str) -> str:
        self.calls.append((session_id, call_id))
        path = self.root / session_id / f"{call_id}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return str(path.resolve())


@pytest.mark.asyncio
async def test_small_output_reuses_stable_content_for_all_projections() -> None:
    result = await ToolResultNormalizer().normalize('{"ok": true, "tool": "bash", "data": "done"}')

    expected = '{"ok": true,"tool": "bash","data": "done"}'
    assert result.terminal_content == expected
    assert result.model_content == expected
    assert result.model_content_policy == {"truncated": False}


@pytest.mark.asyncio
async def test_large_output_uses_one_absolute_output_path(tmp_path: Path) -> None:
    source = json.dumps({"ok": True, "tool": "bash", "data": "head" + "a" * 100_000 + "tail"})
    store = MemoryOutputStore(tmp_path)

    result = await ToolResultNormalizer().normalize(
        source,
        tool_name="bash",
        output_store=store,
        session_id="session-a",
        call_id="call-1",
    )

    assert store.calls == [("session-a", "call-1")]
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    payload = json.loads(result.model_content)
    assert payload["meta"]["truncated"] is True
    assert Path(payload["meta"]["output_path"]).is_absolute()
    assert "Output truncated." in payload["data"]
    assert "Use read_file or bash" in payload["data"]
    assert "a" * 100_000 in (tmp_path / "session-a" / "call-1.txt").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_large_structured_output_previews_its_data_without_quoting_the_envelope(tmp_path: Path) -> None:
    matches = [{"file": "service.ts", "line": n, "text": f'request("assignTask", {n})'} for n in range(2000)]
    source = json.dumps({"ok": True, "tool": "grep", "data": matches, "meta": {"count": 2000}})

    result = await ToolResultNormalizer().normalize(
        source, tool_name="grep", output_store=MemoryOutputStore(tmp_path), session_id="s", call_id="c",
    )

    preview = json.loads(result.model_content)["data"]
    assert preview.startswith('[{"file": "service.ts","line": 0,"text": "request(\\"assignTask\\", 0)"}')
    assert '"ok"' not in preview
    assert '"ok"' not in result.terminal_content.split('"data"', 1)[1]


@pytest.mark.asyncio
async def test_existing_output_path_is_reused_without_duplicate_write() -> None:
    path = "C:/sessions/session-a/tool-output/call-1.txt"
    payload = {"ok": True, "tool": "bash", "data": "preview", "meta": {"truncated": True, "output_path": path}}

    result = await ToolResultNormalizer().normalize(payload, tool_name="bash")

    normalized = json.loads(result.model_content)
    assert normalized["meta"]["output_path"] == path
    assert "Output truncated." in normalized["data"]


@pytest.mark.asyncio
async def test_preview_respects_utf8_bytes_and_lines(tmp_path: Path) -> None:
    source = "\n".join("界" * 40 for _ in range(3000))
    result = await ToolResultNormalizer().normalize(
        source,
        tool_name="read_file",
        output_store=MemoryOutputStore(tmp_path),
        session_id="session-a",
        call_id="call-2",
    )
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    assert json.loads(result.model_content)["meta"]["total_lines"] == 3000


@pytest.mark.asyncio
async def test_large_read_preview_keeps_source_metadata_without_output_store(tmp_path: Path) -> None:
    source = json.dumps(
        {
            "ok": True,
            "tool": "read_file",
            "data": "界" * 30000,
            "meta": {
                "path": "C:/workspace/book.txt",
                "offset": 10,
                "limit": 1000,
                "next_offset": 1010,
                "encoding": "utf-8",
                "truncated": True,
            },
        },
        ensure_ascii=False,
    )
    store = MemoryOutputStore(tmp_path)

    result = await ToolResultNormalizer().normalize(
        source,
        tool_name="read_file",
        output_store=store,
        session_id="session-a",
        call_id="call-read",
    )

    assert store.calls == []
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    payload = json.loads(result.model_content)
    assert payload["meta"]["path"] == "C:/workspace/book.txt"
    assert payload["error_type"] == "InvalidReadResult"
    assert "next_offset" not in payload["meta"]
    assert "output_path" not in payload["meta"]
    assert "original path again" in payload["error"]


@pytest.mark.asyncio
async def test_paginated_read_keeps_full_page_without_preview_truncation(tmp_path: Path) -> None:
    source = json.dumps(
        {
            "ok": True,
            "tool": "read_file",
            "data": "Showing lines 1 to 2:\n1 | first\n2 | second",
            "meta": {"path": "book.txt", "offset": 1, "limit": 2, "next_offset": 3, "truncated": True},
        },
        ensure_ascii=False,
    )

    result = await ToolResultNormalizer().normalize(source, tool_name="read_file", output_store=MemoryOutputStore(tmp_path))

    payload = json.loads(result.model_content)
    assert "1 | first" in payload["data"]
    assert "Read output is limited to the requested page" in payload["data"]


@pytest.mark.asyncio
async def test_error_payload_preserves_error_type() -> None:
    result = await ToolResultNormalizer().normalize(
        '{"tool": "bash", "ok": false, "error_type": "Timeout", "error": "too slow"}'
    )
    assert '"error_type": "Timeout"' in result.model_content
    assert '"error": "too slow"' in result.model_content


@pytest.mark.asyncio
async def test_stable_serialization_for_same_input() -> None:
    normalizer = ToolResultNormalizer()
    first = await normalizer.normalize({"z": 1, "tool": "bash", "ok": True, "data": {"b": 2, "a": 1}})
    second = await normalizer.normalize({"ok": True, "data": {"a": 1, "b": 2}, "z": 1, "tool": "bash"})
    assert first.model_content == second.model_content


@pytest.mark.asyncio
async def test_empty_running_task_still_offers_continuation() -> None:
    payload = {"ok": True, "tool": "task_control", "data": {
        "task_id": "task_empty", "status": "running", "stdout": "", "stderr": "", "exit_code": None}}
    result = await ToolResultNormalizer().normalize(payload)
    assert "still running as task task_empty" in result.model_content


@pytest.mark.asyncio
async def test_shell_model_projection_keeps_the_output_and_the_continuation() -> None:
    payload = {"ok": True, "tool": "bash", "data": {
        "task_id": "task_shell", "status": "running", "return_reason": "yield_timeout",
        "stdout": "hello\n", "stderr": "warn\n", "exit_code": None,
        "next_cursor": "cursor-token", "start_cursor": "cursor-token",
        "owner_session_id": "session", "origin_tool_call_id": "call", "origin_turn_id": "turn",
        "request_id": "request", "shell_executable": "/usr/bin/bash", "cwd": "/work",
        "command": "ls", "elapsed_ms": 12, "finished_at": 1.5},
        "meta": {"truncated": True, "total_bytes": 900, "total_lines": 30, "output_path": "/tmp/task.log"}}
    result = await ToolResultNormalizer().normalize(payload)

    assert result.model_content.startswith("hello\nwarn")
    assert "still running as task task_shell" in result.model_content
    assert "cursor-token" in result.model_content
    assert "Output truncated. Full output is available at /tmp/task.log." in result.model_content
    for bookkeeping in ("owner_session_id", "origin_tool_call_id", "request_id", "shell_executable",
                        "elapsed_ms", "finished_at", '"command"', "start_cursor"):
        assert bookkeeping not in result.model_content


@pytest.mark.asyncio
async def test_shell_model_projection_reports_a_non_zero_exit() -> None:
    payload = {"ok": True, "tool": "bash", "data": {
        "task_id": "task_fail", "status": "exited", "return_reason": "finished",
        "stdout": "", "stderr": "boom\n", "exit_code": 2}}
    result = await ToolResultNormalizer().normalize(payload)

    assert result.model_content == "boom\n\nCommand exited with code 2."


@pytest.mark.asyncio
@pytest.mark.parametrize("output", ["汉" * 20000, "x\n" * 5000], ids=["cjk-bytes", "many-lines"])
async def test_real_shell_shape_respects_model_bounds_and_preserves_full_output(tmp_path, output):
    store = MemoryOutputStore(tmp_path)
    payload = {"ok": True, "tool": "bash", "data": {
        "task_id": "task_big", "status": "exited", "stdout": output, "stderr": "",
        "exit_code": 0, "start_cursor": "start", "next_cursor": "end"}, "meta": {"truncated": False}}
    result = await ToolResultNormalizer().normalize(payload, output_store=store, session_id="session", call_id="call")
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    assert len(result.model_content.splitlines()) <= 2000
    assert "Output truncated." in result.model_content
    full_path = tmp_path / "session" / "call.txt"
    assert str(full_path.resolve()) in result.model_content
    assert json.loads(full_path.read_text(encoding="utf-8"))["data"]["stdout"] == output


@pytest.mark.asyncio
@pytest.mark.parametrize("status,reason", [
    ("timed_out", "Runtime deadline exceeded (100 ms)"),
    ("cancelled", "Explicit task cancellation"),
    ("lost", "Worker owner disappeared"),
    ("failed", "Process could not start"),
])
async def test_shell_projection_preserves_terminal_state_and_reason(status, reason):
    payload = {"ok": True, "tool": "task_control", "data": {
        "task_id": "task", "status": status, "reason": reason, "stdout": "", "stderr": "", "exit_code": None}}
    result = await ToolResultNormalizer().normalize(payload)
    assert status in result.model_content
    assert reason in result.model_content


@pytest.mark.asyncio
async def test_completed_output_page_keeps_sequential_cursor():
    payload = {"ok": True, "tool": "task_control", "data": {
        "task_id": "task", "status": "exited", "stdout": "page", "stderr": "", "exit_code": 0,
        "records": [], "start_cursor": "beginning", "next_cursor": "next-page"},
        "meta": {"truncated": True, "output_path": "/tmp/full.log"}}
    result = await ToolResultNormalizer().normalize(payload)
    assert "task_id task, cursor next-page" in result.model_content


@pytest.mark.asyncio
async def test_shell_diagnostics_alone_cannot_bypass_model_bounds(tmp_path):
    reason = "START-REASON " + "界\n" * 30000 + " END-REASON"
    payload = {"ok": True, "tool": "task_control", "data": {
        "task_id": "task", "status": "lost", "reason": reason, "stdout": "", "stderr": ""}}
    result = await ToolResultNormalizer().normalize(payload, output_store=MemoryOutputStore(tmp_path), session_id="s", call_id="c")
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    assert len(result.model_content.splitlines()) <= 2000
    assert "Command status: lost" in result.model_content
    assert "START-REASON" in result.model_content and "END-REASON" in result.model_content
    assert json.loads((tmp_path / "s/c.txt").read_text(encoding="utf-8"))["data"]["reason"] == reason
