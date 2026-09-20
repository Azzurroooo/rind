"""Canonical file arguments, validation and legacy aliases."""

import json

import pytest

from agent.infrastructure.tools.builtin.files import build_file_tool_specs
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
