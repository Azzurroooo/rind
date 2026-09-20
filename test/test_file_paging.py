"""Read pages cover complete lines within the final model JSON budget."""

import json
import re

import pytest

from agent.application.tools.executor import ToolExecutor
from agent.application.tools.processor import ToolCallProcessor
from agent.application.tools.result_normalizer import ToolResultNormalizer
from agent.domain.tool_payload import ParsedToolCall
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.tools.registry import DefaultToolRegistry
from agent.infrastructure.tools.files.specs import build_file_tool_specs
from agent.infrastructure.tools.files.queries import read_file


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["界中文" * 180, 'escaped "value" \\ tab\t' * 75, "ascii " * 290])
@pytest.mark.parametrize("newline,ending", [("\n", True), ("\r\n", True), ("\n", False)])
async def test_every_line_is_read_once_by_following_model_cursor(tmp_path, text, newline, ending):
    source = [f"{i}: {text}" for i in range(1, 181)]
    path = tmp_path / "book.txt"
    path.write_bytes((newline.join(source) + (newline if ending else "")).encode())
    normalizer = ToolResultNormalizer()
    offset = 1
    seen = []
    for _ in range(len(source)):
        result = await normalizer.normalize(read_file(str(path), offset=offset, limit=110))
        assert len(result.model_content.encode()) <= 25 * 1024
        page = json.loads(result.model_content)
        assert page["ok"] is True
        rows = re.findall(r"^\s*(\d+) \| (.*)$", page["data"], re.M)
        assert rows
        assert [int(n) for n, _ in rows] == list(range(offset, offset + len(rows)))
        assert f"Showing lines {offset} to {offset + len(rows) - 1}:" in page["data"]
        seen.extend(value for _, value in rows)
        next_offset = page["meta"]["next_offset"]
        if next_offset is None:
            break
        assert next_offset == offset + len(rows)
        offset = next_offset
    else:
        pytest.fail("Paging did not reach EOF")
    assert seen == source
    assert seen[79:119] == source[79:119]


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [16000, 80000])
async def test_overlong_line_is_explicit_and_does_not_loop(tmp_path, length):
    path = tmp_path / "wide.txt"
    path.write_text("before\n" + "界" * length + "\nafter", encoding="utf-8")
    normalizer = ToolResultNormalizer()
    page = json.loads((await normalizer.normalize(read_file(str(path)))).model_content)
    assert page["meta"]["next_offset"] == 2
    page = json.loads((await normalizer.normalize(read_file(str(path), offset=2))).model_content)
    assert page["ok"] is False
    assert page["error_type"] == "LineTooLong"
    assert "next_offset" not in page["meta"]
    assert "offset 3" in page["error"] and "character slices" in page["error"]
    with path.open(encoding="utf-8") as stream:
        line = stream.read().splitlines()[1]
    assert "".join(line[i:i + 2000] for i in range(0, len(line), 2000)) == "界" * length
    final = json.loads((await normalizer.normalize(read_file(str(path), offset=3))).model_content)
    assert "3 | after" in final["data"] and final["meta"]["next_offset"] is None


@pytest.mark.asyncio
async def test_line_over_old_2000_character_limit_is_not_silently_clipped(tmp_path):
    path = tmp_path / "long.txt"
    path.write_text("x" * 6000, encoding="utf-8")
    result = await ToolResultNormalizer().normalize(read_file(str(path)))
    page = json.loads(result.model_content)
    assert page["ok"] and "x" * 6000 in page["data"]
    assert page["meta"]["truncated"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("content,lines", [(b"", 0), (b"one\n", 1), (b"\n", 1), (b"\r\n", 1)])
async def test_empty_and_single_line_files_reach_eof(tmp_path, content, lines):
    path = tmp_path / "short.txt"
    path.write_bytes(content)
    result = await ToolResultNormalizer().normalize(read_file(str(path)))
    page = json.loads(result.model_content)
    assert page["ok"] is True
    assert page["data"].startswith(f"Showing lines 1 to {lines}:")
    assert page["meta"]["limit"] == lines and page["meta"]["next_offset"] is None


@pytest.mark.asyncio
async def test_legacy_head_tail_preview_resumes_at_first_gap():
    data = "Showing lines 48 to 157:\n" + "\n".join(f"{n:4d} | line {n}" for n in range(48, 80))
    data += "\n\n... preview truncated ...\n\n" + "\n".join(f"{n:4d} | line {n}" for n in range(120, 158))
    result = await ToolResultNormalizer().normalize({
        "ok": True, "tool": "read_file", "data": data,
        "meta": {"path": "book.txt", "offset": 48, "limit": 110, "next_offset": 158, "truncated": True},
    })
    page = json.loads(result.model_content)
    assert page["data"].startswith("Showing lines 48 to 79:")
    assert page["meta"]["next_offset"] == 80
    assert "120 |" not in page["data"]


@pytest.mark.asyncio
async def test_projected_read_failure_is_reported_and_persisted_as_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    (tmp_path / "wide.txt").write_bytes(("界" * 12000).encode())
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "Read the line")
    processor = ToolCallProcessor(tool_executor=ToolExecutor(DefaultToolRegistry(build_file_tool_specs(tmp_path))))
    call = ParsedToolCall("read-1", "read_file", '{"path":"wide.txt"}')
    events = [event async for event in processor.execute(session=session, tool_calls=[call])]
    assert events[-1].status == "failed" and events[-1].error_type == "LineTooLong"
    record = (await session.get_tool_records())[0]
    assert record["ok"] is False and record["error_type"] == "LineTooLong"
