import asyncio
import json
import io
import threading
import struct
import zlib
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


def test_transparency_orientation_and_animation(tmp_path):
    path = tmp_path / "image.png"
    Image.new("RGBA", (12, 10), (255, 0, 0, 42)).save(path)
    data, mime, *_ = process_image(str(path))
    assert mime == "image/png"
    with Image.open(io.BytesIO(data)) as image:
        assert image.getpixel((0, 0))[3] == 42
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (12, 10)).save(path, format="JPEG", exif=exif)
    data, _, width, height, note = process_image(str(path))
    assert (width, height) == (10, 12) and "EXIF" in note
    with Image.open(io.BytesIO(data)) as image:
        assert not image.getexif()
    Image.new("RGB", (12, 10), "red").save(path, format="GIF", save_all=True,
        append_images=[Image.new("RGB", (12, 10), "blue")], duration=50)
    data, _, _, _, note = process_image(str(path))
    assert "First frame" in note
    with Image.open(io.BytesIO(data)) as image:
        assert image.convert("RGB").getpixel((0, 0)) == (255, 0, 0)


def test_source_limits_checked_before_decoding(tmp_path):
    path = tmp_path / "large.png"
    with path.open("wb") as stream:
        stream.seek(20 * 1024 * 1024)
        stream.write(b"x")
    with pytest.raises(ProviderError, match="20 MiB"):
        process_image(str(path))
    output = io.BytesIO()
    Image.new("RGB", (4, 4)).save(output, format="PNG")
    payload = bytearray(output.getvalue())
    payload[16:24] = struct.pack(">II", 7000, 7000)
    payload[29:33] = struct.pack(">I", zlib.crc32(payload[12:29]))
    path.write_bytes(payload)
    with pytest.raises(ProviderError, match="40 million"):
        process_image(str(path))


def test_atomic_write_failure_cleans_temp_and_preserves_existing(tmp_path, monkeypatch):
    import agent.infrastructure.persistence.image_attachments as module
    source = tmp_path / "source.png"
    Image.new("RGB", (4, 4), "blue").save(source)
    old, _ = capture_image(str(tmp_path / "session"), str(source))
    Image.new("RGB", (4, 4), "red").save(source)
    def fail(*args):
        raise OSError("disk failure")
    monkeypatch.setattr(module.os, "replace", fail)
    with pytest.raises(OSError, match="disk failure"):
        capture_image(str(tmp_path / "session"), str(source))
    assert load_image(str(tmp_path / "session"), old)
    assert len(list((tmp_path / "session" / "attachments").iterdir())) == 1


@pytest.mark.asyncio
async def test_cancel_during_decode_waits_for_worker_without_publishing(tmp_path, monkeypatch):
    import agent.infrastructure.persistence.jsonl_session_store as module
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    Image.new("RGB", (4, 4)).save(uploads / "image.png")
    entered, release, settled = threading.Event(), threading.Event(), threading.Event()
    def blocked(path, token):
        entered.set()
        try:
            assert release.wait(5)
            return process_image(path, token)
        finally:
            settled.set()
    monkeypatch.setattr(module, "process_image", blocked)
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path))
    await store.initialize()
    task = asyncio.create_task(store.persist_user_input("uploads/image.png"))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert settled.is_set() and not store.is_persisted
        assert not list(tmp_path.rglob(".image-*"))
        assert not list(tmp_path.rglob("attachments"))
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_invalid_decoded_upload_group_is_atomic_and_repeats_deduplicate(tmp_path):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    Image.new("RGB", (4, 4)).save(uploads / "good.png")
    (uploads / "bad.png").write_bytes(b"not an image")
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path))
    await store.initialize()
    with pytest.raises(ProviderError):
        await store.persist_user_input("uploads/good.png uploads/bad.png")
    assert not store.is_persisted
    await store.persist_user_input("uploads/good.png uploads/good.png")
    message = (await store.load_messages())[-1]
    assert len(message["attachments"]) == 1
    await store.persist_user_input("plain text")
    assert (await store.load_messages())[-1]["attachments"] == []


def test_untrusted_snapshot_cannot_escape_session(tmp_path):
    ref = {"path": "../other.png", "mime_type": "image/png", "width": 4, "height": 4, "size_bytes": 80}
    with pytest.raises(ProviderError):
        load_image(str(tmp_path), ref)


@pytest.mark.asyncio
async def test_failed_group_save_restores_draft_for_retry(tmp_path, monkeypatch):
    import agent.infrastructure.persistence.jsonl_session_store as module
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    for name, color in [("a", "red"), ("b", "blue")]:
        Image.new("RGB", (4, 4), color).save(uploads / f"{name}.png")
    store = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), workspace_root=str(tmp_path))
    await store.initialize()
    original_save = module.save_image
    calls = []
    def save(base, item, token):
        calls.append(item)
        if len(calls) == 2:
            raise OSError("disk failure")
        return original_save(base, item, token)
    monkeypatch.setattr(module, "save_image", save)
    with pytest.raises(OSError, match="disk failure"):
        await store.persist_user_input("uploads/a.png uploads/b.png")
    assert not store.is_persisted and not list(tmp_path.rglob("attachments"))
    monkeypatch.setattr(module, "save_image", original_save)
    await store.persist_user_input("uploads/a.png")
    assert store.is_persisted
    assert len((await store.load_messages())[-1]["attachments"]) == 1
