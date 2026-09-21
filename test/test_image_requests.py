"""Image request contracts, replacing request-time path promotion and silent fallback."""

import base64
import copy
import io
import json
from unittest.mock import AsyncMock
import asyncio
from functools import partial
from pathlib import Path

import httpx
import openai
import anthropic
from google import genai
from google.genai import types
from PIL import Image
import pytest

from agent.application.images import prepare_image_messages
from agent.domain.errors import ProviderError
from agent.domain.images import upload_references
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.models import ModelStreamEvent, ModelCompletion
from agent.bootstrap.container import build_agent_container
from agent.infrastructure.settings import AppSettings
from agent.infrastructure.persistence import JsonlSessionStore
from agent.application.context.compaction import CompactionService
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.llm.openai_responses import OpenAIResponsesClient
from agent.infrastructure.llm.anthropic_messages import AnthropicMessagesClient
from agent.infrastructure.llm.google_generative_ai import GoogleGenerativeAIClient
from agent.infrastructure.workspace_images import resolve_upload_path


def image_data():
    output = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(output, format="PNG")
    return output.getvalue()


def messages():
    image = {"mime_type": "image/png", "data": image_data()}
    return [
        {"role": "user", "content": "Inspect", "images": [image]},
        {"role": "assistant", "tool_calls": [
            {"id": "a", "function": {"name": "read_file", "arguments": '{"path":"a.png"}'}},
            {"id": "b", "function": {"name": "read_file", "arguments": '{"path":"b.png"}'}},
        ]},
        {"role": "tool", "tool_call_id": "a", "content": "first image", "images": [image]},
        {"role": "tool", "tool_call_id": "b", "content": "second image", "images": [image]},
    ]


def http_library(api):
    return __import__("httpx2") if api == "anthropic" and anthropic.__version__.startswith("1.") else httpx


def sdk_client(api, handle):
    transport_http = http_library(api)
    transport = transport_http.MockTransport(handle)
    if api in {"chat", "responses"}:
        sdk = openai.AsyncOpenAI(api_key="fake", http_client=httpx.AsyncClient(transport=transport), max_retries=0)
        client = OpenAIChatCompletionsClient(sdk, "test") if api == "chat" else OpenAIResponsesClient(sdk, "test")
    elif api == "anthropic":
        sdk = anthropic.AsyncAnthropic(api_key="fake", http_client=transport_http.AsyncClient(transport=transport), max_retries=0)
        client = AnthropicMessagesClient(api_key="fake", model="test", async_client=sdk)
    else:
        sdk = genai.Client(api_key="fake", http_options=types.HttpOptions(async_client_args={"transport": transport}))
        client = GoogleGenerativeAIClient(api_key="fake", model="gemini-3-flash", client=sdk)
    return client


@pytest.mark.asyncio
@pytest.mark.parametrize("api", ["chat", "responses", "anthropic", "google"])
async def test_sdk_serializes_user_and_tool_images(api):
    captured = []
    transport_http = http_library(api)
    def handle(request):
        captured.append(json.loads(request.content))
        if api == "chat":
            data = {"id": "test", "object": "chat.completion", "created": 1, "model": "test", "choices": [{"index": 0, "message": {"role": "assistant", "content": "seen"}, "finish_reason": "stop"}]}
        elif api == "responses":
            data = {"id": "test", "object": "response", "created_at": 1, "status": "completed", "output": [{"type": "message", "id": "m", "role": "assistant", "content": [{"type": "output_text", "text": "seen", "annotations": []}]}]}
        elif api == "anthropic":
            data = {"id": "test", "type": "message", "role": "assistant", "model": "test", "content": [{"type": "text", "text": "seen"}], "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}}
        else:
            data = {"candidates": [{"content": {"role": "model", "parts": [{"text": "seen"}]}, "finishReason": "STOP"}]}
        return transport_http.Response(200, json=data)
    client = sdk_client(api, handle)
    original = messages()
    before = copy.deepcopy(original)
    try:
        await client.create(original, max_output_tokens=64)
    finally:
        await client.close()
    assert original == before
    assert len(captured) == 1
    body = captured[0]
    def image_payloads(value):
        if isinstance(value, str) and value.startswith("data:image/"):
            return [value.split(",", 1)[1]]
        if isinstance(value, dict):
            if "data" in value and ("mimeType" in value or "media_type" in value):
                return [value["data"]]
            return [data for item in value.values() for data in image_payloads(item)]
        if isinstance(value, list):
            return [data for item in value for data in image_payloads(item)]
        return []
    payloads = image_payloads(body)
    assert len(payloads) == 3
    assert all(base64.urlsafe_b64decode(data) == image_data() for data in payloads)
    if api == "chat":
        assert [m["role"] for m in body["messages"]] == ["user", "assistant", "tool", "tool", "user"]
        assert body["messages"][-1]["content"][1]["type"] == "image_url"
    elif api == "responses":
        assert body["input"][-1]["type"] == "function_call_output"
        assert body["input"][-1]["output"][1]["type"] == "input_image"
    elif api == "anthropic":
        blocks = body["messages"][-1]["content"]
        assert [block["tool_use_id"] for block in blocks] == ["a", "b"]
        assert blocks[0]["content"][1]["source"]["type"] == "base64"
    else:
        contents = body["contents"]
        assert len(contents[-2]["parts"]) == 2
        assert "functionResponse" in contents[-2]["parts"][0]
        assert "inlineData" in contents[-1]["parts"][1]


@pytest.mark.asyncio
@pytest.mark.parametrize("capability", [True, False, None])
async def test_capability_does_not_modify_history(capability):
    reference = {"path": "attachments/test.png", "mime_type": "image/png", "width": 4, "height": 4, "size_bytes": 80}
    original = [{"role": "user", "content": "inspect", "attachments": [reference]}]
    load = AsyncMock(return_value=image_data())
    result = await prepare_image_messages(original, load_image=load, image_input=capability)
    assert original[0]["attachments"] == [reference]
    assert "attachments" not in result[0]
    assert load.await_count == (0 if capability is False else 1)
    if capability is False:
        assert "not sent" in result[0]["content"]
    else:
        assert result[0]["images"][0]["data"] == image_data()


def test_upload_paths_reject_escape(tmp_path):
    assert resolve_upload_path(tmp_path, "uploads/../../secret.png") is None
    assert resolve_upload_path(tmp_path, "/uploads/photo.png") is None


@pytest.mark.parametrize("text", [
    "Inspect uploads/photo.jpg.",
    "Inspect uploads/photo.jpg... Then explain it.",
    "Read `uploads/photo.jpg`.",
    "Read (uploads/photo.jpg).",
    "查看 uploads/photo.jpg。",
])
def test_upload_reference_accepts_surrounding_punctuation(text):
    assert upload_references(text) == ["uploads/photo.jpg"]


@pytest.mark.parametrize("text", [
    "uploads/photo.jpg.backup", "uploads/photo.jpg...backup", "uploads/photo.jpg-backup",
    "uploads/photo.jpg/child", "uploads/photo.jpg\\child", "/uploads/photo.jpg",
    "other/uploads/photo.jpg", "myuploads/photo.jpg",
])
def test_upload_reference_does_not_match_part_of_another_path(text):
    assert upload_references(text) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("api", ["chat", "responses", "anthropic", "google"])
async def test_provider_rejection_is_one_request_with_no_payload_leak(api):
    calls = []
    encoded = base64.b64encode(image_data()).decode()
    def reject(request):
        calls.append(request)
        return http_library(api).Response(400, json={"error": {"type": "invalid_request_error", "code": 400, "message": "Unsupported image " + encoded}})
    client = sdk_client(api, reject)
    try:
        with pytest.raises(ProviderError) as error:
            async for event in client.stream(messages()):
                pass
        assert error.value.status == "rejected"
        assert error.value.code != "stream_interrupted"
        assert "Unsupported image" in str(error.value)
        assert encoded not in str(error.value)
        assert len(calls) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("api", ["chat", "responses", "anthropic", "google"])
async def test_cancel_pending_image_request_closes_transport(api):
    entered = asyncio.Event()
    settled = asyncio.Event()
    async def handle(request):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            settled.set()
    client = sdk_client(api, handle)
    cancellation = CancellationTokenSource()
    task = asyncio.create_task(client.create(messages(), cancellation_token=cancellation.token, max_output_tokens=64))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        cancellation.cancel("stop")
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert settled.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("capability", [True, False, None])
async def test_runtime_read_image_reaches_next_request(tmp_path, monkeypatch, capability):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    image = tmp_path / "chart.png"
    image.write_bytes(image_data())
    requests = []
    class Client:
        async def stream(self, messages, **kwargs):
            requests.append(copy.deepcopy(messages))
            if len(requests) == 1:
                yield ModelStreamEvent("tool_start", tool_call_id="read-1", tool_name="read_file")
                yield ModelStreamEvent("tool_arguments_delta", tool_call_id="read-1", arguments=json.dumps({"path": str(image)}))
                yield ModelStreamEvent("tool_end", tool_call_id="read-1")
                yield ModelStreamEvent("completed", stop_reason="tool_calls")
            else:
                yield ModelStreamEvent("text_delta", text="done")
                yield ModelStreamEvent("completed", stop_reason="stop")
    settings = AppSettings(tmp_path / "settings.json", True, "fake", "fake", "http://localhost/v1", "")
    container = build_agent_container(settings=settings, chat_client=Client(), image_input=capability,
                                      session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path),
                                      enabled_tools={"read_file"}, lock_workspace=False)
    try:
        events = [event async for event in container.runtime.run_turn(query="Read chart.png")]
        assert events[-1].type == "turn_completed", events
        assert len(requests) == 2
        tool = next(m for m in requests[1] if m["role"] == "tool")
        records = await container.session_store.get_tool_records()
        raw = await container.session_store.load_messages()
        if capability is False:
            assert "images" not in tool
            assert "does not support images" in tool["content"]
            assert "attachments" not in records[0]
        else:
            assert tool["images"][0]["data"] == image_data()
            assert records[0]["attachments"]
            assert "attachments" not in records[0]["result"]
            assert "attachments" not in next(m for m in raw if m["role"] == "tool")
        notices = [e.decisions["image_notice"] for e in events if e.type == "context_built" and e.decisions.get("image_notice")]
        assert len(notices) == (1 if capability is None else 0)
        image.unlink()
        if capability is not False:
            restored = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=container.session_store.session_id, workspace_root=str(tmp_path))
            await restored.initialize()
            history = await prepare_image_messages(await restored.get_messages_slice(), load_image=restored.load_image, image_input=True)
            assert next(m for m in history if m["role"] == "tool")["images"][0]["data"] == image_data()
    finally:
        container.shell_tools.close_now()
        container.web_sessions.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("capability,count", [(True, 1), (False, 1), (True, 9)])
async def test_compaction_keeps_reread_paths_without_reattaching_history(tmp_path, capability, count):
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path))
    await store.initialize()
    await store.persist_user_input("inspect")
    image = tmp_path / "image.png"
    image.write_bytes(image_data())
    ref, _ = store.capture_image(str(image))
    for i in range(count):
        await store.persist_message("user", f"Image {i}", attachments=[ref])
        await store.persist_message("assistant", "Previous visual observation: red.")
    client = AsyncMock()
    client.create.return_value = ModelCompletion(content="Visual conclusion recorded earlier: red.")
    record = await CompactionService().compact_async(
        store, await store.get_messages_slice(), client,
        prepare_messages=partial(prepare_image_messages, load_image=store.load_image, image_input=capability),
    )
    request = client.create.call_args.kwargs["messages"]
    assert bool(any(m.get("images") for m in request)) == (capability and count <= 8)
    summary = record["handoff_message"]["content"]
    assert Path(store.session_base_path, ref["path"]).resolve().as_posix() in summary
    if not capability or count > 8:
        assert "not re-examined" in summary
    history = await store.get_messages_slice()
    assert not any(m.get("attachments") for m in history)
    assert store.capture_image(str(Path(store.session_base_path, ref["path"])))[0] == ref
    from agent.infrastructure.persistence import fork_session
    import shutil
    fork_id = fork_session(str(tmp_path / "sessions"), store.session_id)
    fork = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id=fork_id, workspace_root=str(tmp_path))
    await fork.initialize()
    fork_summary = (await fork.get_latest_compaction())["handoff_message"]["content"]
    assert Path(fork.session_base_path, ref["path"]).resolve().as_posix() in fork_summary
    shutil.rmtree(store.session_base_path)
    assert fork.capture_image(str(Path(fork.session_base_path, ref["path"])))[0] == ref


@pytest.mark.asyncio
async def test_request_budget_and_missing_snapshot_are_explicit():
    from agent.application.images import check_image_budget
    refs = [{"path": "attachments/missing.png", "mime_type": "image/png", "width": 4, "height": 4, "size_bytes": 3 * 1024 * 1024}]
    for group in (refs * 9, refs * 5):
        with pytest.raises(ProviderError, match="16 MiB"):
            check_image_budget(group)
    load = AsyncMock(side_effect=ProviderError("Snapshot missing"))
    with pytest.raises(ProviderError, match="Snapshot missing"):
        await prepare_image_messages([{"role": "user", "content": "inspect", "attachments": refs}], load_image=load, image_input=True)


def test_legacy_images_notice_excludes_new_inputs():
    from agent.runtime.server.resume_preview import render_resume_preview
    old = [{"role": "user", "content": "uploads/old.png"}]
    assert render_resume_preview(old).count("no image snapshot") == 1
    assert "no image snapshot" not in render_resume_preview([{**old[0], "attachments": []}])


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["steering", "follow_up"])
async def test_queued_upload_captures_at_delivery(tmp_path, monkeypatch, mode):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    source = uploads / "queued.png"
    source.write_bytes(image_data())
    entered, release = asyncio.Event(), asyncio.Event()
    requests = []
    class Client:
        async def stream(self, messages, **kwargs):
            requests.append(copy.deepcopy(messages))
            if len(requests) == 1:
                entered.set()
                await release.wait()
            yield ModelStreamEvent("text_delta", text="done")
            yield ModelStreamEvent("completed", stop_reason="stop")
    settings = AppSettings(tmp_path / "settings.json", True, "fake", "fake", "http://localhost/v1", "")
    container = build_agent_container(settings=settings, chat_client=Client(), image_input=True,
        session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path), enabled_tools={"read_file"}, lock_workspace=False)
    async def consume():
        return [event async for event in container.runtime.run_turn(query="start")]
    task = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if mode == "steering":
            container.runtime.submit_steering("uploads/queued.png")
        else:
            container.runtime.submit_follow_up("uploads/queued.png")
        Image.new("RGB", (4, 4), "blue").save(source)
        delivered_data = source.read_bytes()
        release.set()
        events = await asyncio.wait_for(task, 5)
        assert events[-1].type == "turn_completed"
        assert len(requests) == 2
        user = next(m for m in requests[-1] if m.get("images"))
        assert user["images"][0]["data"] == delivered_data
        raw = [m for m in await container.session_store.load_messages() if m["role"] == "user"]
        assert raw[0]["attachments"] == [] and len(raw[1]["attachments"]) == 1
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        container.shell_tools.close_now()
        container.web_sessions.close()


@pytest.mark.asyncio
async def test_old_image_budget_compacts_once_and_oversized_tool_group_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    requests = []
    class Client:
        create = AsyncMock(return_value=ModelCompletion(content="Prior image observations retained."))
        async def stream(self, messages, **kwargs):
            requests.append(messages)
            yield ModelStreamEvent("text_delta", text="done")
            yield ModelStreamEvent("completed", stop_reason="stop")
    client = Client()
    settings = AppSettings(tmp_path / "settings.json", True, "fake", "fake", "http://localhost/v1", "")
    container = build_agent_container(settings=settings, chat_client=client, image_input=True,
        session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path), enabled_tools={"read_file"}, lock_workspace=False)
    try:
        await container.runtime.initialize()
        store = container.session_store
        await store.persist_user_input("start")
        source = tmp_path / "image.png"
        source.write_bytes(image_data())
        ref, _ = store.capture_image(str(source))
        for i in range(9):
            await store.persist_message("user", f"Image {i}", attachments=[ref])
            await store.persist_message("assistant", "red")
        events = [event async for event in container.runtime.run_turn(query="continue")]
        assert events[-1].type == "turn_completed", events
        assert client.create.await_count == 1 and len(requests) == 1
        assert sum(len(m.get("images", [])) for m in requests[0]) <= 8
        assert not any(m.get("images") for m in client.create.call_args.kwargs["messages"])
        await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "large", "name": "read_file", "raw_args": "{}"}]})
        await store.persist_tool_call("large", "read_file", {}, "{}", "start", "end", "read", model_content="read", attachments=[ref] * 9)
        await store.persist_message("tool", "", tool_call_id="large", tool_name="read_file")
        events = [event async for event in container.turn_runner.run_turn(store)]
        assert events[-1].type == "turn_failed" and "8 images" in events[-1].error
        assert client.create.await_count == 1 and len(requests) == 1
    finally:
        container.shell_tools.close_now()
        container.web_sessions.close()
