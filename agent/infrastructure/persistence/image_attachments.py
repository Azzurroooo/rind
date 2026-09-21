"""Immutable image snapshots scoped to one session."""

from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import re
import tempfile

from PIL import Image

from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError
from agent.domain.images import ImageAttachment
from agent.infrastructure.images import MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, check_cancelled, process_image

_ATTACHMENT_PATH = re.compile(r"attachments/([0-9a-f]{64})\.(png|jpg)")


def attachment_path(session_base: str, relative: str) -> Path:
    if not _ATTACHMENT_PATH.fullmatch(relative):
        raise ProviderError("Invalid session image reference.", status="rejected", code="InvalidAttachment")
    base = Path(session_base).resolve()
    path = (base / relative).resolve()
    if not path.is_relative_to(base) or path.parent != base / "attachments":
        raise ProviderError("Image reference escapes this session.", status="rejected", code="InvalidAttachment")
    return path


def load_image(session_base: str, attachment: ImageAttachment) -> bytes:
    try:
        path = attachment_path(session_base, attachment["path"])
        with path.open("rb") as source:
            data = source.read(MAX_IMAGE_BYTES + 1)
        if (not 0 < len(data) <= MAX_IMAGE_BYTES or len(data) != attachment["size_bytes"]
                or hashlib.sha256(data).hexdigest() != path.stem):
            raise ValueError("size or hash mismatch")
        with Image.open(io.BytesIO(data)) as image:
            mime = {"PNG": "image/png", "JPEG": "image/jpeg"}.get(image.format)
            if (mime != attachment["mime_type"] or image.size != (attachment["width"], attachment["height"])
                    or not 0 < max(image.size) <= MAX_IMAGE_EDGE
                    or path.suffix != (".png" if mime == "image/png" else ".jpg")):
                raise ValueError("image metadata mismatch")
            image.verify()
        return data
    except (OSError, KeyError, TypeError, ValueError, Image.DecompressionBombError) as exc:
        raise ProviderError("Session image is missing or damaged. Read the original image again.", status="rejected", code="AttachmentUnavailable") from exc


def save_image(session_base: str, processed: tuple[bytes, str, int, int, str], token: CancellationToken | None = None) -> ImageAttachment:
    data, mime, width, height, _ = processed
    suffix = "png" if mime == "image/png" else "jpg"
    reference: ImageAttachment = {
        "path": f"attachments/{hashlib.sha256(data).hexdigest()}.{suffix}",
        "mime_type": mime, "width": width, "height": height, "size_bytes": len(data),
    }
    path = attachment_path(session_base, reference["path"])
    check_cancelled(token)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        load_image(session_base, reference)
        return reference
    fd, name = tempfile.mkstemp(prefix=".image-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        check_cancelled(token)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
    return reference


def capture_image(session_base: str, path: str, token: CancellationToken | None = None) -> tuple[ImageAttachment, str]:
    source = Path(path).resolve()
    if source.parent == Path(session_base).resolve() / "attachments":
        relative = "attachments/" + source.name
        attachment_path(session_base, relative)
        with Image.open(source) as image:
            reference: ImageAttachment = {
                "path": relative, "mime_type": "image/png" if source.suffix == ".png" else "image/jpeg",
                "width": image.width, "height": image.height, "size_bytes": source.stat().st_size,
            }
        load_image(session_base, reference)
        check_cancelled(token)
        return reference, ""
    processed = process_image(path, token)
    return save_image(session_base, processed, token), processed[-1]
