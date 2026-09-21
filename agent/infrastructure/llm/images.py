"""Shared wire helpers for the existing provider adapters."""

import base64
import re

from agent.domain.images import RequestImage


def redact_image_text(text: str) -> str:
    text = re.sub(r"data:image/[^;\s]+;base64,[A-Za-z0-9+/=_-]+", "[image data omitted]", text)
    return re.sub(r"(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{80,}={0,2}", "[encoded data omitted]", text)


def image_data_url(image: RequestImage) -> str:
    return f"data:{image['mime_type']};base64,{base64.b64encode(image['data']).decode('ascii')}"


def separate_tool_images(messages: list[dict]) -> list[dict]:
    """Place images after a complete group of text-only tool results."""
    result = []
    pending = []
    sources = []

    def flush():
        if pending:
            result.append({"role": "user", "content": "Images from tool results (in order):\n" + "\n".join(sources), "images": list(pending)})
            pending.clear()
            sources.clear()

    for message in messages:
        if message.get("role") != "tool":
            flush()
            result.append(message)
            continue
        copied = dict(message)
        for image in copied.pop("images", []):
            pending.append(image)
            sources.append(f"Image {len(pending)}: tool call {message.get('tool_call_id', '')}")
        result.append(copied)
    flush()
    return result


def chat_messages(messages: list[dict]) -> list[dict]:
    result = []
    for message in separate_tool_images(messages):
        copied = dict(message)
        images = copied.pop("images", [])
        if images:
            copied["content"] = [
                {"type": "text", "text": str(copied.get("content") or "")},
                *({"type": "image_url", "image_url": {"url": image_data_url(image)}} for image in images),
            ]
        result.append(copied)
    return result
