"""Small formatting helpers shared by CLI adapters."""

from __future__ import annotations


def display_value(value: object, default: str = "unknown") -> str:
    text = str(value or "").strip()
    return text or default


def clip_text(value: object, limit: int, *, strip: bool = True) -> str:
    text = str(value or "")
    if strip:
        text = text.strip()
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 3)]}..."


def tail_clip_text(value: object, limit: int, *, strip: bool = True) -> str:
    text = str(value or "")
    if strip:
        text = text.strip()
    if len(text) <= limit:
        return text
    keep = max(0, limit - 3)
    return "..." + (text[-keep:] if keep else "")


def single_line(value: object) -> str:
    return str(value or "").replace("\n", " ").strip()


def escaped_newlines(value: object) -> str:
    return str(value or "").replace("\n", "\\n")


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def nonnegative_int(value: object) -> int:
    return max(0, safe_int(value or 0))
