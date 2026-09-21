"""Provider-independent image references and request data."""

import re
from typing import TypedDict


class ImageAttachment(TypedDict):
    path: str
    mime_type: str
    width: int
    height: int
    size_bytes: int


class RequestImage(TypedDict):
    mime_type: str
    data: bytes


_UPLOAD_REFERENCE = re.compile(
    r"(?<![\w./\\])(uploads/[A-Za-z0-9._\-/]+\.(?:png|jpg|jpeg|webp|gif|bmp))(?![\w/\\-]|\.+[\w/\\-])",
    re.IGNORECASE,
)


def upload_references(content: str) -> list[str]:
    return list(dict.fromkeys(match.group(1) for match in _UPLOAD_REFERENCE.finditer(content)))
