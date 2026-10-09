"""Host-declared tools: each keeps its own schema and reaches the host by its name."""

from __future__ import annotations

import json
import sys

import pytest

from agent.infrastructure.tools.external import ExternalTool
from agent.infrastructure.tools.registry import DefaultToolRegistry

DELEGATE = {
    "name": "delegate",
    "description": "Give work to a direct report.",
    "parameters": {"type": "object", "properties": {"to": {"type": "string"}, "brief": {"type": "string"}}, "required": ["brief"]},
}


def _tool(**extra) -> ExternalTool:
    return ExternalTool.from_json(json.dumps({"command": sys.executable, "tools": [DELEGATE], **extra}))


def test_each_declared_tool_is_offered_with_its_own_schema():
    spec, = _tool().specs("session-1")
    assert spec.schema["function"] == {"name": "delegate", "description": "Give work to a direct report.", "parameters": DELEGATE["parameters"]}


@pytest.mark.asyncio
async def test_a_call_reaches_the_host_by_tool_name_without_runtime_arguments(monkeypatch):
    tool = _tool()
    calls = []

    async def call(self, session_id, method, parameters, env=None):
        calls.append((session_id, method, parameters))
        return {"ok": True, "result": {"task": "t1"}}

    monkeypatch.setattr(ExternalTool, "call", call)
    registry = DefaultToolRegistry(tool.specs("session-1"))
    result = await registry.call_async("delegate", {"to": "a1", "brief": "Build it", "_cancellation_token": object()})
    assert calls == [("session-1", "delegate", {"to": "a1", "brief": "Build it"})]
    assert json.loads(result) == {"ok": True, "result": {"task": "t1"}}
    missing = await registry.call_async("delegate", {"to": "a1"})
    assert "Missing arguments: brief" in missing and len(calls) == 1


@pytest.mark.parametrize("tools, message", [
    ("delegate", "list of declarations"),
    ([{"name": "delegate"}], "name and a description"),
    ([{**DELEGATE, "parameters": {"type": "string"}}], "object parameter schema"),
])
def test_a_malformed_declaration_is_refused(tools, message):
    with pytest.raises(ValueError, match=message):
        _tool(tools=tools)


def test_a_schema_without_required_fields_requires_none():
    spec, = _tool(tools=[{**DELEGATE, "parameters": {"type": "object", "properties": {}}}]).specs("s")
    assert spec.schema["function"]["parameters"]["required"] == []
