"""Prepare session image references for any provider without filesystem coupling."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from agent.domain.errors import ProviderError
from agent.domain.images import ImageAttachment, upload_references

MAX_REQUEST_IMAGES = 8
MAX_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024
LEGACY_IMAGE_NOTICE = "Older uploads references have no image snapshot. Resend the uploads reference or use read_file to inspect the image."


def has_legacy_images(messages: list[dict]) -> bool:
    return any(message.get("role") == "user" and "attachments" not in message
               and upload_references(str(message.get("content") or "")) for message in messages)


def check_image_budget(attachments: list[dict]) -> None:
    encoded_bytes = sum(4 * ((item["size_bytes"] + 2) // 3) for item in attachments)
    if len(attachments) > MAX_REQUEST_IMAGES or encoded_bytes > MAX_REQUEST_IMAGE_BYTES:
        raise ProviderError("Image request exceeds 8 images or 16 MiB encoded data. Compact older history or send fewer images.", status="rejected", code="image_budget_exceeded")


def image_budget_exceeded(messages: list[dict]) -> bool:
    try:
        check_image_budget([item for message in messages for item in message.get("attachments", [])])
    except ProviderError:
        return True
    return False


async def prepare_image_messages(
    messages: list[dict], *, load_image: Callable[[ImageAttachment], Awaitable[bytes]],
    image_input: bool | None, compact: bool = False,
) -> list[dict]:
    omitted = ""
    if image_input is False:
        omitted = "Image not sent: the current model does not support images. Select a vision model to inspect it."
    elif compact and image_budget_exceeded(messages):
        omitted = "Images not re-examined for this summary: image request limit exceeded. Use prior observations and references only."
    else:
        check_image_budget([item for message in messages for item in message.get("attachments", [])])
    result = []
    for message in messages:
        copied = dict(message)
        attachments = copied.pop("attachments", [])
        if attachments:
            if omitted:
                sources = ", ".join(item["path"] for item in attachments)
                copied["content"] = str(copied.get("content") or "") + f"\n[{omitted} References: {sources}]"
            else:
                copied["images"] = [{"mime_type": item["mime_type"], "data": await load_image(item)} for item in attachments]
        elif has_legacy_images([message]):
            copied["content"] = str(copied.get("content") or "") + "\n[" + LEGACY_IMAGE_NOTICE + "]"
        result.append(copied)
    return result
