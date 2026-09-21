import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.infrastructure.llm import trace as llm_trace
from agent.infrastructure.llm.trace import LlmCallTrace, make_trace, resolve_trace_dir, trace_enabled, _serialize
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.bootstrap.container import build_agent_container
from agent.infrastructure.settings import AppSettings


def test_trace_enabled_respects_env(monkeypatch):
    monkeypatch.delenv("RIND_TRACE_LLM", raising=False)
    assert trace_enabled() is False
    monkeypatch.setenv("RIND_TRACE_LLM", "1")
    assert trace_enabled() is True
    monkeypatch.setenv("RIND_TRACE_LLM", "nope")
    assert trace_enabled() is False


def test_resolve_trace_dir_is_none_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("RIND_TRACE_LLM", raising=False)
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)
    assert resolve_trace_dir("s1") is None


def test_resolve_trace_dir_uses_session_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("RIND_TRACE_LLM", "1")
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)
    result = resolve_trace_dir("s1")
    assert result == tmp_path / "sessions" / "s1" / "_llm_trace"
    assert result.is_dir()


def test_serialize_handles_model_dump_and_primitives():
    obj = SimpleNamespace(model_dump=lambda: {"choices": [{"delta": {"tool_calls": [{"id": "x"}]}}]})
    assert _serialize(obj) == {"choices": [{"delta": {"tool_calls": [{"id": "x"}]}}]}
    assert _serialize([1, "a", True]) == [1, "a", True]


def test_image_trace_redacts_every_wire_shape_and_error_echo(tmp_path):
    import copy
    import base64
    payload = bytes(range(256))
    encoded = base64.b64encode(payload).decode()
    request = {"images": [{"mime_type": "image/png", "data": payload}], "content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + encoded}},
        {"type": "input_image", "image_url": "data:image/png;base64," + encoded},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encoded}},
        {"inlineData": {"mimeType": "image/png", "data": encoded}},
    ]}
    before = copy.deepcopy(request)
    trace = LlmCallTrace(tmp_path)
    trace.request(request)
    trace.response(request)
    trace.end("error", "Provider echoed payload: " + encoded)
    assert request == before
    output = trace.path.read_text(encoding="utf-8")
    assert encoded not in output and "data:image/" not in output
    assert "image/png" in output and "omitted" in output


def test_make_trace_off_by_default(monkeypatch, tmp_path):
    monkeypatch.delenv("RIND_TRACE_LLM", raising=False)
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)
    assert make_trace(lambda: "s1", label="stream") is None


def test_call_trace_writes_request_chunk_end(monkeypatch, tmp_path):
    monkeypatch.setenv("RIND_TRACE_LLM", "1")
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)

    trace = make_trace(lambda: "s1", label="stream")
    assert trace is not None
    trace.request({"model": "m", "messages": [{"role": "user", "content": "hi"}], "tools": [], "stream": True})
    trace.response_chunk(SimpleNamespace(model_dump=lambda: {"choices": [{"delta": {"content": "a"}}]}))
    trace.response_chunk(SimpleNamespace(model_dump=lambda: {"choices": [{"delta": {"tool_calls": [{"id": "c1"}]}}]}))
    trace.end("completed")

    lines = [json.loads(line) for line in trace.path.read_text(encoding="utf-8").splitlines()]
    assert [record["direction"] for record in lines] == ["request", "response", "response", "end"]
    assert lines[1]["chunk"]["choices"][0]["delta"]["content"] == "a"
    assert lines[2]["chunk"]["choices"][0]["delta"]["tool_calls"][0]["id"] == "c1"
    assert lines[-1]["reason"] == "completed"


@pytest.mark.asyncio
async def test_chat_client_stream_traces_when_enabled(monkeypatch, tmp_path):
    monkeypatch.setenv("RIND_TRACE_LLM", "1")
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)

    chunks = [
        {"choices": [{"delta": payload}]}
        for payload in [{"content": "Hi"}, {"tool_calls": [{"id": "call_1", "function": {"name": "bash"}}]}]
    ]

    async def _aiter():
        for chunk in chunks:
            yield chunk

    mock_openai = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(return_value=_aiter())

    client = OpenAIChatCompletionsClient(mock_openai, "test-model")
    client.set_trace_session_id_provider(lambda: "sess-trace")

    received = []
    async for chunk in client.stream(messages=[{"role": "user", "content": "go"}], tools=[{"name": "bash"}]):
        received.append(chunk)

    assert len(received) == 2
    trace_files = list((tmp_path / "sessions" / "sess-trace" / "_llm_trace").glob("*.jsonl"))
    assert len(trace_files) == 1
    records = [json.loads(line) for line in trace_files[0].read_text(encoding="utf-8").splitlines()]
    directions = [record["direction"] for record in records]
    assert directions == ["request", "response", "response", "end"]
    assert records[0]["model"] == "test-model"
    assert records[0]["tools"] == [{"name": "bash"}]
    assert records[0]["tool_choice"] == "auto"
    second_delta = records[2]["chunk"]["choices"][0]["delta"]
    assert second_delta["tool_calls"][0]["function"]["name"] == "bash"
    assert records[-1]["reason"] == "completed"


@pytest.mark.asyncio
async def test_chat_client_stream_does_not_trace_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("RIND_TRACE_LLM", raising=False)
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)

    async def _aiter():
        yield SimpleNamespace(model_dump=lambda: {"choices": [{"delta": {"content": "Hi"}}]})

    mock_openai = MagicMock()
    mock_openai.chat.completions.create = AsyncMock(return_value=_aiter())

    client = OpenAIChatCompletionsClient(mock_openai, "test-model")
    client.set_trace_session_id_provider(lambda: "sess-trace")

    async for _ in client.stream(messages=[{"role": "user", "content": "go"}]):
        pass

    assert not (tmp_path / "sessions").exists()


def test_call_trace_survives_missing_end(monkeypatch, tmp_path):
    monkeypatch.setenv("RIND_TRACE_LLM", "1")
    monkeypatch.setattr(llm_trace, "resolve_rind_home", lambda: tmp_path)

    trace = LlmCallTrace(resolve_trace_dir("s2"), label="stream")
    trace.request({"model": "m", "stream": True})
    # simulate a crash: write a chunk but never call end()
    trace.response_chunk({"choices": [{"delta": {"content": "partial"}}]})
    trace.close()

    lines = [json.loads(line) for line in trace.path.read_text(encoding="utf-8").splitlines()]
    assert [record["direction"] for record in lines] == ["request", "response"]


@pytest.mark.asyncio
async def test_manual_compact_traces_before_the_first_turn_in_a_worker(monkeypatch, tmp_path):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("RIND_TRACE_LLM", "1")
    sdk = MagicMock()
    sdk.chat.completions.create = AsyncMock(return_value={
        "choices": [{"message": {"content": "Keep the delivery code."}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 8},
    })
    container = build_agent_container(
        chat_client=OpenAIChatCompletionsClient(sdk, "trace-model"),
        settings=AppSettings(
            settings_path=tmp_path / "settings.json", settings_exists=False,
            api_key="local-only", base_url="http://127.0.0.1:1/v1",
            model="trace-model", reasoning_effort="",
        ),
        workspace_root=str(tmp_path),
    )
    try:
        await container.session_store.initialize()
        await container.session_store.persist_message("user", "Remember the delivery code.")
        await container.session_store.persist_message("assistant", "Understood.")
        record = await container.runtime.compact_context()
        assert record["strategy"] == "llm_inline"
        trace_files = list((tmp_path / "home" / "sessions" / container.session_store.session_id / "_llm_trace").glob("*.jsonl"))
        assert len(trace_files) == 1
        records = [json.loads(line) for line in trace_files[0].read_text(encoding="utf-8").splitlines()]
        assert records[0]["stream"] is False
        assert "Remember the delivery code." in json.dumps(records[0]["messages"])
        assert records[-1]["reason"] == "completed"
    finally:
        await container.shell_tools.close()
        container.web_sessions.close()
