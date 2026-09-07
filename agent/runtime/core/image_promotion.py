"""W5 multimodal image promotion for user messages.

Scans user message text for literal ``uploads/<name>.<ext>`` references
(ext in png/jpg/jpeg/webp/gif). When the referenced file exists under the
workspace root and is at most 4MB, the user message content is promoted to
Chat Completions content parts: the original text (kept intact) plus one
``image_url`` data-URL part per reference. Any problem (missing file,
oversize, unsafe path, read error) degrades silently to the original text.

Pure functions only; TurnRunner supplies the workspace root from the session
store. Path safety mirrors agent/runtime/server/files.py without importing it
(runtime/core must not depend on runtime/server).
"""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path, PurePosixPath

# Consistent with agent/runtime/server/files.py mime mapping.
IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

IMAGE_PART_MAX_BYTES = 4 * 1024 * 1024

# Literal `uploads/...` tokens only: not preceded by a word char, path
# separator, or dot (rejects /abs/uploads/.., ../uploads/.., myuploads/..),
# plain forward-slash segments, image suffix at the token end.
_UPLOADS_REF = re.compile(
    r"(?<![\w./\\])(uploads/[A-Za-z0-9._\-/]+\.(?:png|jpg|jpeg|webp|gif))(?![\w.])",
    re.IGNORECASE,
)


def resolve_upload_path(workspace_root: str | Path | None, rel_path: str) -> Path | None:
    """Resolve an uploads-relative path, returning None for any unsafe path."""
    if not workspace_root or not rel_path:
        return None
    candidate = PurePosixPath(rel_path)
    if candidate.is_absolute() or not candidate.parts:
        return None
    if any(part in ("", ".", "..") for part in candidate.parts):
        return None
    try:
        root = Path(workspace_root)
        resolved = (root / Path(*candidate.parts)).resolve()
        if not resolved.is_relative_to(root.resolve()):
            return None
        real_root = Path(os.path.realpath(root))
        if not Path(os.path.realpath(resolved)).is_relative_to(real_root):
            return None
    except (OSError, ValueError):
        return None
    return resolved


def image_parts_for_text(text: str, workspace_root: str | Path | None) -> list[dict]:
    """Return image_url data-URL parts for promotable uploads references in text."""
    parts: list[dict] = []
    seen: set[str] = set()
    for match in _UPLOADS_REF.finditer(text or ""):
        rel_path = match.group(1)
        if rel_path in seen:
            continue
        seen.add(rel_path)
        resolved = resolve_upload_path(workspace_root, rel_path)
        if resolved is None or not resolved.is_file():
            continue
        mime = IMAGE_MIME_TYPES.get(resolved.suffix.lower())
        if mime is None:
            continue
        try:
            if resolved.stat().st_size > IMAGE_PART_MAX_BYTES:
                continue
            payload = base64.b64encode(resolved.read_bytes()).decode("ascii")
        except OSError:
            continue
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{payload}"}})
    return parts


def promote_user_images(
    messages: list[dict],
    workspace_root: str | Path | None,
) -> tuple[list[dict], bool]:
    """Promote uploads image references in user messages to content parts.

    Returns ``(request_messages, promoted_any)``. Non-user messages, string
    content without qualifying references, and unusable workspace roots pass
    through unchanged, so requests without image references are identical to
    the unpromoted message list.
    """
    if not workspace_root:
        return messages, False
    promoted_any = False
    result: list[dict] = []
    for message in messages:
        if (
            not isinstance(message, dict)
            or message.get("role") != "user"
            or not isinstance(message.get("content"), str)
        ):
            result.append(message)
            continue
        parts = image_parts_for_text(message["content"], workspace_root)
        if not parts:
            result.append(message)
            continue
        promoted = dict(message)
        promoted["content"] = [{"type": "text", "text": message["content"]}, *parts]
        result.append(promoted)
        promoted_any = True
    return result, promoted_any


__all__ = [
    "IMAGE_MIME_TYPES",
    "IMAGE_PART_MAX_BYTES",
    "image_parts_for_text",
    "promote_user_images",
    "resolve_upload_path",
]
