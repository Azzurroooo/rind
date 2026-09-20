"""File arguments, compact mutation receipts and persisted replay contracts."""

import json

import pytest

from agent.application.tools.executor import ToolExecutor
from agent.application.tools.processor import ToolCallProcessor
from agent.application.tools.result_normalizer import ToolResultNormalizer
from agent.domain.events import FileChangeEvent
from agent.domain.tool_payload import ParsedToolCall
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.tools.builtin.files import build_file_tool_specs, edit_file, write_file
from agent.infrastructure.tools.registry import DefaultToolRegistry


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["path", "file_path"])
async def test_file_alias_is_normalized_before_sync_and_async_dispatch(tmp_path, field):
    registry = DefaultToolRegistry(build_file_tool_specs(tmp_path))
    for schema in registry.schemas:
        properties = schema["function"]["parameters"]["properties"]
        assert "path" in properties and "file_path" not in properties
    result = json.loads(await registry.call_async("write_file", {field: "a.txt", "content": "old", "expected_sha256": "old-hash"}))
    assert result["ok"]
    result = json.loads(await registry.call_async("edit_file", {field: "a.txt", "old_str": "old", "new_str": "new", "expected_sha256": "old-hash"}))
    assert result["ok"]
    assert "new" in json.loads(registry.call("read_file", {field: "a.txt"}))["data"]
    assert json.loads(registry.call("glob", {field: ".", "pattern": "*.txt"}))["ok"]
    assert json.loads(registry.call("grep", {field: ".", "pattern": "new"}))["ok"]
    assert json.loads(registry.call("read_file", {"path": "a.txt", "file_path": "a.txt"}))["ok"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,missing,unknown", [
    ("read_file", {}, ["path"], []),
    ("write_file", {"content": "x"}, ["path"], []),
    ("edit_file", {"path": "a.txt", "new_str": "x"}, ["old_str"], []),
    ("glob", {"pattern": "*", "typo": "x"}, [], ["typo"]),
    ("write_file", {"path": "a.txt", "content": "x", "typo": "x"}, [], ["typo"]),
])
async def test_arguments_fail_once_with_actionable_metadata(tmp_path, name, args, missing, unknown):
    registry = DefaultToolRegistry(build_file_tool_specs(tmp_path))
    raw = await registry.call_async(name, args) if registry.is_async(name) else registry.call(name, args)
    result = json.loads(raw)
    assert result["error_type"] == "InvalidArguments"
    assert result["meta"]["missing"] == missing
    assert result["meta"]["unknown"] == unknown
    assert "path" in result["meta"]["allowed"]
    assert not (tmp_path / "a.txt").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["read_file", "write_file", "edit_file", "glob", "grep"])
async def test_conflicting_aliases_are_rejected_before_effects(tmp_path, name):
    registry = DefaultToolRegistry(build_file_tool_specs(tmp_path))
    args = {"path": "a.txt", "file_path": "b.txt"}
    raw = await registry.call_async(name, args) if registry.is_async(name) else registry.call(name, args)
    assert json.loads(raw)["error_type"] == "InvalidArguments"
    assert "Conflicting" in json.loads(raw)["error"]
    assert args == {"path": "a.txt", "file_path": "b.txt"}


@pytest.mark.asyncio
async def test_write_receipt_drops_diff_but_terminal_and_audit_keep_it(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), system_prompt="sys")
    await session.initialize()
    await session.persist_message("user", "Write the report")
    content = "unique report content " * 160 + "\n" + "remaining content\n" * 200
    args = {"path": "report.txt", "content": content}
    call = ParsedToolCall("w1", "write_file", json.dumps(args))
    await session.persist_message("assistant", "", meta={"tool_calls": [{"id": call.call_id, "name": call.name, "raw_args": call.raw_args}]})
    processor = ToolCallProcessor(tool_executor=ToolExecutor(DefaultToolRegistry(build_file_tool_specs(tmp_path))))
    events = [event async for event in processor.execute(session=session, tool_calls=[call], turn_id="t1")]
    change = next(event for event in events if isinstance(event, FileChangeEvent))
    assert change.file_path == "report.txt"
    record = (await session.get_tool_records())[0]
    receipt = json.loads(record["model_content"])
    assert len(record["model_content"]) < 1000
    assert "unique report content" not in record["model_content"]
    assert "unique report content" in record["result"]["meta"]["files"][0]["diff"]
    assert "unique report content" in events[-1].result
    file = receipt["meta"]["files"][0]
    assert file["created"] is True and file["size_bytes"] == len(content.encode())
    reopened = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=session.session_id)
    await reopened.initialize()
    projected = await reopened.get_messages_slice()
    assert projected[-1]["content"] == record["model_content"]
    before = json.dumps(await session.get_tool_records(), sort_keys=True)
    _ = [event async for event in processor.execute(session=reopened, tool_calls=[call], turn_id="t2")]
    assert json.dumps(await reopened.get_tool_records(), sort_keys=True) == before


@pytest.mark.asyncio
async def test_edit_receipt_shows_location_statistics_and_small_context(tmp_path):
    path = tmp_path / "edit.txt"
    path.write_text("before\nold\nafter\n", encoding="utf-8")
    normalizer = ToolResultNormalizer()
    result = await normalizer.normalize(edit_file(str(path), "old", "new"))
    meta = json.loads(result.model_content)["meta"]["files"][0]
    assert meta["start_line"] == 2 and meta["added_lines"] == meta["removed_lines"] == 1
    assert "-old" in meta["diff"] and "+new" in meta["diff"]
    result = await normalizer.normalize(edit_file(str(path), "new", "huge change\n" * 500))
    assert len(result.model_content) < 2000
    assert "diff preview truncated" in result.model_content
    result = await normalizer.normalize(edit_file(str(path), "missing", "x"))
    assert json.loads(result.model_content)["error_type"] == "OldStrNotFound"
    result = await normalizer.normalize(write_file(str(path), "replacement"))
    assert json.loads(result.model_content)["meta"]["files"][0]["created"] is False
