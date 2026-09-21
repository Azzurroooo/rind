import asyncio
import json
from pathlib import Path

from PIL import Image
import pytest

from agent.application.tools.result_normalizer import ToolResultNormalizer
from agent.domain.cancellation import CancellationTokenSource
from agent.domain.errors import ProviderError
from agent.infrastructure.images import process_image
from agent.infrastructure.persistence.image_attachments import capture_image, load_image
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.tools.files.queries import read_file


@pytest.mark.parametrize("format", ["PNG", "JPEG", "WEBP", "GIF", "BMP"])
def test_process_actual_images(tmp_path, format):
    source = tmp_path / "misnamed.txt"
    Image.new("RGB", (2100, 100), "blue").save(source, format=format)
    payload, mime, width, height, note = process_image(str(source))
    assert width == 2000 and height < 100
    assert mime in {"image/png", "image/jpeg"}
    assert len(payload) < 3 * 1024 * 1024
    assert "Original 2100x100" in note


def test_capture_reuses_snapshot_and_checks_integrity(tmp_path):
    source = tmp_path / "original.png"
    Image.new("RGBA", (16, 12), (1, 2, 3, 4)).save(source)
    base = tmp_path / "session"
    ref, _ = capture_image(str(base), str(source))
    before = load_image(str(base), ref)
    source.unlink()
    second, _ = capture_image(str(base), str(base / ref["path"]))
    assert second == ref
    assert load_image(str(base), second) == before
    (base / ref["path"]).write_bytes(b"bad")
    with pytest.raises(ProviderError, match="missing or damaged"):
        load_image(str(base), ref)
    assert not list(base.rglob(".image-*"))


def test_reject_invalid_and_cancelled_images(tmp_path):
    source = tmp_path / "bad.png"
    source.write_bytes(b"\x89PNG\r\n\x1a\n-not-a-real-image")
    with pytest.raises(ProviderError, match="decoded"):
        process_image(str(source))
    cancellation = CancellationTokenSource()
    cancellation.cancel("stop")
    with pytest.raises(asyncio.CancelledError):
        process_image(str(source), cancellation.token)


@pytest.mark.asyncio
async def test_read_result_preserves_image_outside_text_budget(tmp_path):
    source = tmp_path / "image.png"
    Image.new("RGB", (12, 10)).save(source)
    result = read_file(str(source), capture_image=lambda path, token: capture_image(str(tmp_path / "session"), path, token))
    normalized = await ToolResultNormalizer().normalize(result, tool_name="read_file")
    assert len(normalized.attachments) == 1
    assert "attachments" not in json.loads(normalized.model_content)
    assert "Read image" in normalized.terminal_content
    assert json.loads(read_file(str(source), image_input=False))["error_type"] == "ImageInputUnsupported"
    assert json.loads(read_file(str(source), offset=2))["error_type"] == "InvalidImagePagination"


@pytest.mark.asyncio
async def test_user_snapshot_survives_original_deletion(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    source = uploads / "example.png"
    Image.new("RGB", (12, 10)).save(source)
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path), system_prompt="test")
    await store.initialize()
    await store.persist_user_input("Inspect uploads/example.png")
    messages = await store.get_messages_slice()
    ref = messages[-1]["attachments"][0]
    source.unlink()
    assert await store.load_image(ref)
    raw = Path(store.session_base_path, "messages.jsonl").read_text(encoding="utf-8")
    assert "base64" not in raw


@pytest.mark.asyncio
async def test_invalid_group_does_not_create_session(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    (tmp_path / "uploads").mkdir()
    Image.new("RGB", (4, 4)).save(tmp_path / "uploads/good.png")
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path), system_prompt="test")
    await store.initialize()
    with pytest.raises(ValueError):
        await store.persist_user_input("uploads/good.png uploads/missing.png")
    assert not store.is_persisted
    assert not list(tmp_path.rglob("attachments"))
