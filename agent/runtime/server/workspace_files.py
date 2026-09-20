"""Workspace file access for remote surfaces: file/list, file/read, file/write.

Pure path/encoding logic; the server dispatcher only unpacks params and maps
FileMethodError to a protocol error response.
"""

from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path

FILE_LIMIT_BYTES = 8 * 1024 * 1024

_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".csv": "text/csv",
    ".zip": "application/zip",
}


class FileMethodError(Exception):
    def __init__(self, message: str, error_type: str):
        super().__init__(message)
        self.message = message
        self.error_type = error_type


def mime_for_suffix(suffix: str) -> str:
    key = suffix.lower()
    if not key.startswith("."):
        key = Path(key).suffix.lower()
    return _MIME_TYPES.get(key, "application/octet-stream")


def resolve_workspace_path(workspace_root: str | Path, path: str) -> Path:
    """Resolve a workspace-relative path, rejecting every escape route.

    An empty path resolves to the workspace root itself (file/list default).
    """
    if not isinstance(path, str):
        raise FileMethodError("path must be a string.", "InvalidRequest")
    candidate = Path(path)
    if candidate.is_absolute():
        raise FileMethodError("path must be relative to the workspace.", "InvalidRequest")
    if any(part == ".." for part in candidate.parts):
        raise FileMethodError("path must not contain '..' segments.", "InvalidRequest")
    root = Path(workspace_root).resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root):
        raise FileMethodError("path escapes the workspace.", "InvalidRequest")
    real_root = Path(os.path.realpath(root))
    if not Path(os.path.realpath(resolved)).is_relative_to(real_root):
        raise FileMethodError("path escapes the workspace.", "InvalidRequest")
    return resolved


def file_list(workspace_root: str | Path, path: str) -> dict:
    resolved = resolve_workspace_path(workspace_root, path)
    if not resolved.exists():
        raise FileMethodError(f"Directory not found: {path}", "NotFound")
    if not resolved.is_dir():
        raise FileMethodError(f"Not a directory: {path}", "InvalidRequest")
    entries = []
    for child in sorted(resolved.iterdir(), key=lambda item: item.name):
        if child.is_dir():
            entries.append({"name": child.name, "type": "dir", "size": 0})
        else:
            try:
                size = child.stat().st_size
            except OSError:
                size = 0
            entries.append({"name": child.name, "type": "file", "size": size})
    return {"entries": entries}


def file_read(workspace_root: str | Path, path: str) -> dict:
    resolved = resolve_workspace_path(workspace_root, path)
    try:
        size = resolved.stat().st_size
    except FileNotFoundError:
        raise FileMethodError(f"File not found: {path}", "NotFound") from None
    except OSError as exc:
        raise FileMethodError(f"Cannot read file: {exc}", "InvalidRequest") from None
    if resolved.is_dir():
        raise FileMethodError(f"Not a file: {path}", "InvalidRequest")
    if size > FILE_LIMIT_BYTES:
        raise FileMethodError(f"File exceeds the {FILE_LIMIT_BYTES} byte limit.", "PayloadTooLarge")
    data = resolved.read_bytes()
    return {
        "content_base64": base64.b64encode(data).decode("ascii"),
        "mime": mime_for_suffix(resolved.suffix),
        "size": size,
    }


def file_write(workspace_root: str | Path, path: str, content_base64: str) -> dict:
    resolved = resolve_workspace_path(workspace_root, path)
    uploads_root = Path(workspace_root).resolve() / "uploads"
    if not resolved.is_relative_to(uploads_root):
        raise FileMethodError("file/write is restricted to the uploads/ directory.", "InvalidRequest")
    real_uploads = Path(os.path.realpath(uploads_root))
    if not Path(os.path.realpath(resolved)).is_relative_to(real_uploads):
        raise FileMethodError("file/write is restricted to the uploads/ directory.", "InvalidRequest")
    if not isinstance(content_base64, str):
        raise FileMethodError("content_base64 must be a string.", "InvalidRequest")
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise FileMethodError("content_base64 is not valid base64.", "DecodeError") from None
    if len(data) > FILE_LIMIT_BYTES:
        raise FileMethodError(f"File exceeds the {FILE_LIMIT_BYTES} byte limit.", "PayloadTooLarge")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_bytes(data)
    return {"path": path, "size": len(data)}


__all__ = [
    "FILE_LIMIT_BYTES",
    "FileMethodError",
    "file_list",
    "mime_for_suffix",
    "read_file",
    "resolve_workspace_path",
    "write_file",
]
