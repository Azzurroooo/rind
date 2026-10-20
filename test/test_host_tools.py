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
    payload = json.loads(result)
    assert payload["ok"] is True and payload["tool"] == "delegate"
    assert payload["data"] == {"task": "t1"}
    missing = await registry.call_async("delegate", {"to": "a1"})
    assert "Missing arguments: brief" in missing and len(calls) == 1


@pytest.mark.asyncio
async def test_a_host_refusal_becomes_a_structured_tool_error(monkeypatch):
    tool = _tool()

    async def call(self, session_id, method, parameters, env=None):
        return {"ok": False, "error": {"code": "WORKSPACE_SHARED", "message": "Share it explicitly."}}

    monkeypatch.setattr(ExternalTool, "call", call)
    registry = DefaultToolRegistry(tool.specs("session-1"))
    payload = json.loads(await registry.call_async("delegate", {"to": "a1", "brief": "Build it"}))

    assert payload["ok"] is False and payload["tool"] == "delegate"
    assert payload["error"] == "Share it explicitly."
    assert payload["error_type"] == "WORKSPACE_SHARED"


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



@pytest.mark.asyncio
async def test_host_declared_delegate_calls_run_in_parallel_until_wait_barrier(monkeypatch):
    import asyncio
    from agent.application.tools.executor import ToolExecutor
    from agent.application.tools.processor import ToolCallProcessor
    from agent.domain import ParsedToolCall

    tool = _tool(tools=[{
        "name": "delegate",
        "description": "Coordinate work with direct reports.",
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "brief": {"type": "string"},
                "wait": {"type": "boolean"},
            },
        },
    }])
    active = 0
    max_active = 0
    order = []

    async def call(self, session_id, method, parameters, env=None):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        tag = "wait" if parameters.get("wait") else parameters.get("to")
        order.append(f"start:{tag}")
        try:
            await asyncio.sleep(0.02)
            order.append(f"end:{tag}")
            return {"ok": True, "result": {"tag": tag}}
        finally:
            active -= 1

    class DummySession:
        session_id = "session-1"
        def now_iso(self):
            return "2026-05-21T00:00:00Z"
        async def get_tool_records(self, **kwargs):
            return []
        async def persist_tool_call(self, *args, **kwargs):
            pass
        async def persist_message(self, *args, **kwargs):
            pass

    monkeypatch.setattr(ExternalTool, "call", call)
    registry = DefaultToolRegistry(tool.specs("session-1"))
    processor = ToolCallProcessor(ToolExecutor(registry))
    calls = [
        ParsedToolCall(call_id="c1", name="delegate", raw_args='{"to":"ui","brief":"A"}'),
        ParsedToolCall(call_id="c2", name="delegate", raw_args='{"to":"api","brief":"B"}'),
        ParsedToolCall(call_id="c3", name="delegate", raw_args='{"wait":true}'),
    ]
    _ = [event async for event in processor.execute(DummySession(), calls)]
    assert max_active == 2
    assert order.index("end:ui") < order.index("start:wait")
    assert order.index("end:api") < order.index("start:wait")
