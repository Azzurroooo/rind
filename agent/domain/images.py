"""Provider-independent image references and request data."""

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
