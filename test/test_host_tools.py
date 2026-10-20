"""Host-declared tools: each keeps its own schema and reaches the host by its name."""

from __future__ import annotations

import asyncio
import json
import sys

import pytest

from agent.domain.cancellation import CancellationTokenSource
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


@pytest.mark.asyncio
async def test_cancelling_token_terminates_running_external_tool_process(tmp_path):
    pid_file = tmp_path / "child.pid"
    tool = _tool(args=["-c", f"import os, pathlib, time; pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)"])
    registry = DefaultToolRegistry(tool.specs("session-1"))
    source = CancellationTokenSource()

    async def cancel_soon():
        for _ in range(100):
            if pid_file.exists():
                break
            await asyncio.sleep(0.02)
        source.cancel("Turn interrupted")

    canceller = asyncio.create_task(cancel_soon())
    result = await registry.call_async("delegate", {"brief": "Wait", "_cancellation_token": source.token})
    await canceller
    payload = json.loads(result)
    assert payload["ok"] is False
    assert payload["error_type"] == "Cancelled"
    assert payload["meta"]["reason"] == "Turn interrupted"


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
