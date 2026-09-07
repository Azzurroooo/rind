import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.files import (
    FILE_LIMIT_BYTES,
    FileMethodError,
    file_list,
    file_read,
    file_write,
    mime_for_suffix,
    resolve_workspace_path,
)
from agent.runtime.server.stdio import WorkerStdioRuntimeServer


class _CaptureWriter:
    def __init__(self):
        self.payloads = []

    async def send(self, payload):
        self.payloads.append(payload)


class _FakeExecution:
    def set_event_sink(self, sink):
        pass


class _FakeWorker:
    workspace_root = ""
    execution = _FakeExecution()


def _make_server(workspace: Path) -> tuple[WorkerStdioRuntimeServer, _CaptureWriter]:
    writer = _CaptureWriter()
    worker = _FakeWorker()
    worker.workspace_root = str(workspace)
    server = WorkerStdioRuntimeServer(worker, writer=writer)
    server._initialized = True
    return server, writer


def _request(method: str, params: dict) -> dict:
    return {"kind": "request", "request_id": f"{method}-1", "method": method, "params": params}


# --- files.py pure functions -------------------------------------------------


def test_list_dir_returns_sorted_entries(tmp_path):
    (tmp_path / "b.txt").write_text("hello")
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "nested.txt").write_text("x" * 11)

    result = file_list(tmp_path, "")
    names = [entry["name"] for entry in result["entries"]]
    assert names == ["a", "b.txt"]
    assert result["entries"][0] == {"name": "a", "type": "dir", "size": 0}
    assert result["entries"][1]["type"] == "file"

    sub = file_list(tmp_path, "a")
    assert sub["entries"] == [{"name": "nested.txt", "type": "file", "size": 11}]


def test_list_dir_missing_directory_is_not_found(tmp_path):
    with pytest.raises(FileMethodError) as excinfo:
        file_list(tmp_path, "missing")
    assert excinfo.value.error_type == "NotFound"


def test_read_file_round_trips_text_and_binary(tmp_path):
    (tmp_path / "note.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "data.bin").write_bytes(bytes(range(256)))

    note = file_read(tmp_path, "note.txt")
    assert note["mime"] == "text/plain"
    assert note["size"] == 5
    assert base64.b64decode(note["content_base64"]) == b"hello"

    data = file_read(tmp_path, "data.bin")
    assert data["mime"] == "application/octet-stream"
    assert base64.b64decode(data["content_base64"]) == bytes(range(256))


def test_read_file_rejects_oversize(tmp_path):
    big = tmp_path / "big.bin"
    big.write_bytes(b"\0" * (FILE_LIMIT_BYTES + 1))
    with pytest.raises(FileMethodError) as excinfo:
        file_read(tmp_path, "big.bin")
    assert excinfo.value.error_type == "PayloadTooLarge"


def test_read_file_missing_is_not_found(tmp_path):
    with pytest.raises(FileMethodError) as excinfo:
        file_read(tmp_path, "missing.txt")
    assert excinfo.value.error_type == "NotFound"


def test_write_file_creates_overwrites_and_mkdirs(tmp_path):
    result = file_write(tmp_path, "uploads/sub/note.txt", base64.b64encode(b"hello").decode())
    assert result == {"path": "uploads/sub/note.txt", "size": 5}
    assert (tmp_path / "uploads" / "sub" / "note.txt").read_bytes() == b"hello"

    overwrite = file_write(tmp_path, "uploads/sub/note.txt", base64.b64encode(b"bye!").decode())
    assert overwrite["size"] == 4
    assert (tmp_path / "uploads" / "sub" / "note.txt").read_bytes() == b"bye!"


def test_write_file_outside_uploads_is_rejected(tmp_path):
    for path in ("elsewhere/note.txt", "uploads_evil.txt", "a/../uploads/note.txt"):
        with pytest.raises(FileMethodError) as excinfo:
            file_write(tmp_path, path, base64.b64encode(b"x").decode())
        assert excinfo.value.error_type == "InvalidRequest"


def test_write_file_rejects_invalid_base64(tmp_path):
    with pytest.raises(FileMethodError) as excinfo:
        file_write(tmp_path, "uploads/note.txt", "not-base64!!!")
    assert excinfo.value.error_type == "DecodeError"


def test_write_file_rejects_oversize(tmp_path):
    payload = base64.b64encode(b"\0" * (FILE_LIMIT_BYTES + 1)).decode()
    with pytest.raises(FileMethodError) as excinfo:
        file_write(tmp_path, "uploads/big.bin", payload)
    assert excinfo.value.error_type == "PayloadTooLarge"
    assert not (tmp_path / "uploads" / "big.bin").exists()


def test_path_validation_rejects_escapes(tmp_path):
    for path in ("../outside.txt", "a/../../outside.txt", "C:/Windows/system32", "/etc/passwd"):
        with pytest.raises(FileMethodError) as excinfo:
            resolve_workspace_path(tmp_path, path)
        assert excinfo.value.error_type == "InvalidRequest"


def test_symlink_escape_is_rejected(tmp_path):
    outside = tmp_path.parent / f"outside-{os.getpid()}.txt"
    outside.write_text("secret")
    uploads = tmp_path / "uploads"
    uploads.mkdir(exist_ok=True)
    link = uploads / "leak.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlink not permitted on this platform")

    with pytest.raises(FileMethodError) as read_exc:
        file_read(tmp_path, "uploads/leak.txt")
    assert read_exc.value.error_type == "InvalidRequest"
    with pytest.raises(FileMethodError) as write_exc:
        file_write(tmp_path, "uploads/leak.txt", base64.b64encode(b"x").decode())
    assert write_exc.value.error_type == "InvalidRequest"


def test_mime_table_covers_common_suffixes():
    assert mime_for_suffix(".png") == "image/png"
    assert mime_for_suffix(".jpg") == "image/jpeg"
    assert mime_for_suffix(".PDF") == "application/pdf"
    assert mime_for_suffix(".unknown") == "application/octet-stream"


# --- dispatcher wiring --------------------------------------------------------


def test_dispatcher_serves_file_list(tmp_path):
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "note.txt").write_text("hello")
    server, writer = _make_server(tmp_path)

    asyncio.run(server.dispatch(_request("file/list", {"path": "uploads"})))

    assert writer.payloads == [
        {
            "kind": "response",
            "request_id": "file/list-1",
            "result": {"entries": [{"name": "note.txt", "size": 5, "type": "file"}]},
        }
    ]


def test_dispatcher_maps_file_errors(tmp_path):
    server, writer = _make_server(tmp_path)

    asyncio.run(server.dispatch(_request("file/read", {"path": "missing.txt"})))
    error = writer.payloads[-1]
    assert error["error"]["type"] == "NotFound"

    asyncio.run(server.dispatch(_request("file/write", {"path": "nope.txt", "content_base64": ""})))
    error = writer.payloads[-1]
    assert error["error"]["type"] == "InvalidRequest"

    asyncio.run(server.dispatch(_request("file/write", {"path": "uploads/x.txt", "content_base64": "!!"})))
    error = writer.payloads[-1]
    assert error["error"]["type"] == "DecodeError"
