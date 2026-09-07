"""W5 multimodal image promotion tests (worker-core.md §5).

Covers: promotion into image_url data-URL parts, missing/oversize/unsafe path
degradation, one-shot text-only retry on provider 4xx with the image_fallback
flag on emitted events, and byte-identical requests for prompts without image
references.
"""

import asyncio
import base64
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT
from agent.domain.errors import ProviderError
from agent.domain.events import (
    AssistantMessageCompletedEvent,
    ContextBuiltEvent,
    TurnCompletedEvent,
    TurnFailedEvent,
    TurnStepRetryEvent,
)
from agent.infrastructure.llm.openai_chat_client import OpenAIChatClient
from agent.runtime.core.image_promotion import (
    IMAGE_MIME_TYPES,
    IMAGE_PART_MAX_BYTES,
    image_parts_for_text,
    promote_user_images,
    resolve_upload_path,
)
from agent.runtime.core.turn_runner import TurnRunner


PNG_BYTES = b"\x89PNG\r\n\x1a\n-fake-image"


class _EmptyStream:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _RecordingChatClient:
    """Records every request payload passed to stream()."""

    def __init__(self):
        self.requests = []

    def stream(self, messages, tools=None, cancellation_token=None):
        self.requests.append([dict(message) for message in messages])
        return _EmptyStream()


class _FakeSession:
    def __init__(self, workspace_root=None):
        self.workspace_root = str(workspace_root) if workspace_root else None
        self.session_id = "session_1"
        self.persisted = []

    async def get_turn_state(self):
        return None

    async def persist_turn_state(self, turn_id, status, ts, recovery_attempt=None):
        return None

    async def persist_message(self, role, content, **kwargs):
        self.persisted.append((role, content))

    def now_iso(self):
        return "2026-05-08T00:00:00Z"


class _ProviderCapture:
    """Fake OpenAI async client capturing chat.completions.create payloads."""

    def __init__(self):
        self.payloads = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **payload):
        self.payloads.append(payload)
        return _EmptyStream()


def _make_workspace(tmp_path, filename="photo.png", payload=PNG_BYTES):
    uploads = tmp_path / "uploads"
    uploads.mkdir(exist_ok=True)
    (uploads / filename).write_bytes(payload)
    return tmp_path


def _runner(chat_client, context_messages, consume_side_effect=None, context_manager=None):
    parser = MagicMock()
    if consume_side_effect is None:
        parser.consume_async_stream = AsyncMock(return_value=("Done", [], None, None, None))
    else:
        parser.consume_async_stream = AsyncMock(side_effect=consume_side_effect)
    if context_manager is None:
        context_manager = MagicMock()
        context_manager.build_messages_async = AsyncMock(
            return_value=MagicMock(messages=context_messages, stats={}, decisions={})
        )
    return TurnRunner(
        chat_client=chat_client,
        tool_processor=MagicMock(),
        stream_parser=parser,
        tool_schemas=[],
        context_manager=context_manager,
    )


def _run_turn(runner, session):
    async def run():
        return [event async for event in runner.run_turn(session, turn_id="turn_1")]

    return asyncio.run(run())


def test_promotion_success_builds_image_url_data_url_part(tmp_path):
    workspace = _make_workspace(tmp_path)
    chat_client = _RecordingChatClient()
    runner = _runner(
        chat_client,
        [{"role": "user", "content": "看这张图 uploads/photo.png"}],
    )

    events = _run_turn(runner, _FakeSession(workspace))

    request = chat_client.requests[0]
    content = request[0]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "看这张图 uploads/photo.png"}
    image_part = content[1]
    assert image_part["type"] == "image_url"
    url = image_part["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == PNG_BYTES
    assert isinstance(events[-1], TurnCompletedEvent)
    assert events[-1].image_fallback is False


def test_promotion_mime_mapping_matches_files_py(tmp_path):
    workspace = _make_workspace(tmp_path)
    for suffix, mime in IMAGE_MIME_TYPES.items():
        (workspace / "uploads" / f"sample{suffix}").write_bytes(b"x")
        parts = image_parts_for_text(f"uploads/sample{suffix}", workspace)
        assert len(parts) == 1
        assert parts[0]["image_url"]["url"].startswith(f"data:{mime};base64,"), suffix
    assert IMAGE_MIME_TYPES[".png"] == "image/png"
    assert IMAGE_MIME_TYPES[".jpg"] == "image/jpeg"
    assert IMAGE_MIME_TYPES[".jpeg"] == "image/jpeg"
    assert IMAGE_MIME_TYPES[".webp"] == "image/webp"
    assert IMAGE_MIME_TYPES[".gif"] == "image/gif"


def test_promoted_user_message_keeps_text_and_deduplicates(tmp_path):
    workspace = _make_workspace(tmp_path)
    chat_client = _RecordingChatClient()
    session = _FakeSession(workspace)
    text = "两张都要 uploads/photo.png 和 uploads/photo.png"
    runner = _runner(chat_client, [{"role": "user", "content": text}])

    _run_turn(runner, session)

    content = chat_client.requests[0][0]["content"]
    assert content[0]["text"] == text  # surrounding text stays natural
    assert len(content) == 2  # duplicate references collapse into one image part
    assert all(role != "user" for role, _content in session.persisted)


def test_missing_file_degrades_to_text_only(tmp_path):
    chat_client = _RecordingChatClient()
    runner = _runner(
        chat_client,
        [{"role": "user", "content": "看这张图 uploads/missing.png"}],
    )

    events = _run_turn(runner, _FakeSession(tmp_path))

    assert chat_client.requests[0][0]["content"] == "看这张图 uploads/missing.png"
    assert isinstance(events[-1], TurnCompletedEvent)
    assert events[-1].image_fallback is False


def test_oversize_file_degrades_to_text_only(tmp_path):
    workspace = _make_workspace(tmp_path, payload=b"\0" * (IMAGE_PART_MAX_BYTES + 1))
    chat_client = _RecordingChatClient()
    runner = _runner(
        chat_client,
        [{"role": "user", "content": "看这张图 uploads/photo.png"}],
    )

    events = _run_turn(runner, _FakeSession(workspace))

    assert chat_client.requests[0][0]["content"] == "看这张图 uploads/photo.png"
    assert isinstance(events[-1], TurnCompletedEvent)


def test_file_exactly_at_4mb_limit_is_promoted(tmp_path):
    workspace = _make_workspace(tmp_path, payload=b"\0" * IMAGE_PART_MAX_BYTES)
    chat_client = _RecordingChatClient()
    runner = _runner(
        chat_client,
        [{"role": "user", "content": "uploads/photo.png"}],
    )

    _run_turn(runner, _FakeSession(workspace))

    assert isinstance(chat_client.requests[0][0]["content"], list)


def test_unsafe_paths_degrade_to_text_only(tmp_path):
    workspace = _make_workspace(tmp_path, filename="secret.png")
    unsafe_texts = [
        "外面这张 ../uploads/secret.png 看看",
        "这张 uploads/../../uploads/secret.png 看看",
        "这张 uploads/secret.png/../../secret.png 看看",
        f"绝对路径 {tmp_path / 'uploads' / 'secret.png'} 看看",
    ]
    for text in unsafe_texts:
        chat_client = _RecordingChatClient()
        runner = _runner(chat_client, [{"role": "user", "content": text}])

        _run_turn(runner, _FakeSession(workspace))

        assert chat_client.requests[0][0]["content"] == text, text


def test_resolve_upload_path_rejects_escape_routes(tmp_path):
    workspace = _make_workspace(tmp_path, filename="secret.png")

    assert resolve_upload_path(None, "uploads/secret.png") is None
    assert resolve_upload_path(workspace, "/abs/uploads/secret.png") is None
    assert resolve_upload_path(workspace, "../uploads/secret.png") is None
    assert resolve_upload_path(workspace, "uploads/../secret.png") is None
    assert resolve_upload_path(workspace, "uploads/nested/../../secret.png") is None

    resolved = resolve_upload_path(workspace, "uploads/secret.png")
    assert resolved is not None
    assert resolved.is_file()
    dot_resolved = resolve_upload_path(workspace, "uploads/./secret.png")
    assert dot_resolved is not None  # './' segments normalize away and stay contained
    assert dot_resolved.is_file()

    # Existence is deliberately a caller-side check (is_file): a safe but
    # missing path resolves, while image_parts_for_text degrades to no parts.
    missing = resolve_upload_path(workspace, "uploads/does-not-exist.png")
    assert missing is not None and not missing.is_file()
    assert image_parts_for_text("uploads/does-not-exist.png", workspace) == []


def test_non_image_references_and_non_user_messages_are_untouched(tmp_path):
    workspace = _make_workspace(tmp_path, filename="notes.txt")
    (workspace / "uploads" / "notes.txt").write_text("hello")
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "读取 uploads/notes.txt"},
        {"role": "assistant", "content": "ok"},
    ]

    promoted, promoted_any = promote_user_images(messages, workspace)

    assert promoted_any is False
    assert promoted == messages


def test_promotion_without_workspace_root_is_noop():
    messages = [{"role": "user", "content": "uploads/photo.png"}]

    promoted, promoted_any = promote_user_images(messages, None)

    assert promoted == messages
    assert promoted_any is False


def test_provider_rejection_retries_once_text_only_and_sets_image_fallback(tmp_path):
    workspace = _make_workspace(tmp_path)
    chat_client = _RecordingChatClient()
    text = "看这张图 uploads/photo.png"
    runner = _runner(
        chat_client,
        [{"role": "user", "content": text}],
        consume_side_effect=[
            ProviderError(
                "Image input is not supported by this model.",
                status="rejected",
                error_type="BadRequestError",
            ),
            ("Done", [], None, None, None),
        ],
    )

    events = _run_turn(runner, _FakeSession(workspace))

    assert len(chat_client.requests) == 2
    assert isinstance(chat_client.requests[0][0]["content"], list)  # first try carried the image
    retry_events = [event for event in events if isinstance(event, TurnStepRetryEvent)]
    assert len(retry_events) == 1
    assert retry_events[0].reason == "image_fallback"
    assert chat_client.requests[1] == [{"role": "user", "content": text}]  # one text-only retry
    completed = next(event for event in events if isinstance(event, AssistantMessageCompletedEvent))
    assert completed.image_fallback is True
    assert isinstance(events[-1], TurnCompletedEvent)
    assert events[-1].image_fallback is True


def test_provider_rejection_without_promoted_images_does_not_retry(tmp_path):
    chat_client = _RecordingChatClient()
    runner = _runner(
        chat_client,
        [{"role": "user", "content": "普通提问，无图"}],
        consume_side_effect=[
            ProviderError("Bad request", status="rejected", error_type="BadRequestError"),
        ],
    )

    events = _run_turn(runner, _FakeSession(tmp_path))

    assert len(chat_client.requests) == 1
    assert not any(isinstance(event, TurnStepRetryEvent) for event in events)
    assert isinstance(events[-1], TurnFailedEvent)
    assert events[-1].status == "rejected"


def test_context_length_error_keeps_existing_recovery_path(tmp_path):
    workspace = _make_workspace(tmp_path)
    chat_client = _RecordingChatClient()
    text = "看这张图 uploads/photo.png"
    context_with_image = SimpleNamespace(
        messages=[{"role": "user", "content": text}],
        stats={},
        decisions={},
    )
    handoff_context = SimpleNamespace(
        messages=[
            {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
            {"role": "assistant", "content": "handoff"},
        ],
        stats={},
        decisions={},
    )
    context_manager = MagicMock()
    context_manager.build_messages_async = AsyncMock(
        side_effect=[context_with_image, handoff_context, handoff_context]
    )
    compaction_service = MagicMock()
    compaction_service.compact_async = AsyncMock(return_value={})
    runner = _runner(
        chat_client,
        None,
        consume_side_effect=[
            ProviderError(
                "context_length_exceeded",
                status="rejected",
                error_type="BadRequestError",
                code="context_length_exceeded",
            ),
            ("", [], None, None, None),
        ],
        context_manager=context_manager,
    )
    runner._compaction_service = compaction_service

    events = _run_turn(runner, _FakeSession(workspace))

    assert not any(
        isinstance(event, TurnStepRetryEvent) and event.reason == "image_fallback"
        for event in events
    )
    assert len(chat_client.requests) == 2
    assert isinstance(chat_client.requests[0][0]["content"], list)  # image was promoted
    assert chat_client.requests[1] == handoff_context.messages
    assert isinstance(events[-1], TurnCompletedEvent)
    assert events[-1].image_fallback is False


def test_prompts_without_image_references_produce_identical_requests(tmp_path):
    messages = [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "普通中文提问，没有图片"},
    ]
    chat_client = _RecordingChatClient()
    runner = _runner(chat_client, messages)

    events = _run_turn(runner, _FakeSession(tmp_path))

    assert chat_client.requests == [messages]
    assert chat_client.requests[0][0]["content"] == messages[0]["content"]
    assert isinstance(events[0], ContextBuiltEvent)
    assert isinstance(events[-1], TurnCompletedEvent)
    assert events[-1].image_fallback is False
    completed = next(event for event in events if isinstance(event, AssistantMessageCompletedEvent))
    assert completed.image_fallback is False


def test_openai_chat_client_passes_list_content_through_to_provider():
    capture = _ProviderCapture()
    client = OpenAIChatClient(async_client=capture, model="test-model")
    messages = [
        {"role": "system", "content": "sys"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "hi"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
        },
    ]

    async def run():
        async for _chunk in client.stream(messages=messages):
            pass

    asyncio.run(run())

    assert capture.payloads[0]["messages"] == messages  # list content reaches the provider intact


def test_openai_chat_client_keeps_string_content_path_unchanged():
    capture = _ProviderCapture()
    client = OpenAIChatClient(async_client=capture, model="test-model")
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "plain string prompt"},
    ]

    async def run():
        async for _chunk in client.stream(messages=messages):
            pass

    asyncio.run(run())

    assert capture.payloads[0]["messages"] == messages
