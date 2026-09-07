"""Fence-aware chunking and plain-text degradation (pure functions).

Algorithm order per remote-plan/gateway.md §6:
① split on blank lines (never inside ``` fences) ② over-limit paragraphs split
on sentence/newline boundaries ③ hard cut that never splits a UTF-16 surrogate
pair (``len_unit="utf16"`` counts code units and always lands on a codepoint
boundary).  Per-piece cap = ``max_text_length - 200`` to leave room for a
one-line task title.
"""

from __future__ import annotations

import re

TITLE_RESERVE = 200
CHOICE_LIMIT = 5
TITLE_MAX_CHARS = 48
_SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？；;!?])|(?<=\.)\s|\n")


def first_line_title(text: str) -> str:
    """One-line task title for the first outbound piece (gateway.md §5)."""
    lines = text.strip().splitlines()
    return lines[0][:TITLE_MAX_CHARS] if lines else ""


def unit_length(text: str, len_unit: str = "chars") -> int:
    """Length in codepoints, or UTF-16 code units when len_unit is "utf16"."""
    if len_unit != "utf16":
        return len(text)
    return sum(2 if ord(char) > 0xFFFF else 1 for char in text)


def split_text(text: str, max_text_length: int, len_unit: str = "chars") -> list[str]:
    """Split ``text`` into pieces that each fit under the per-piece cap."""
    cap = max(1, max_text_length - TITLE_RESERVE)
    if unit_length(text, len_unit) <= cap:
        return [text]
    pieces: list[str] = []
    current = ""
    for block in _paragraphs(text):
        if unit_length(block, len_unit) <= cap:
            candidate = f"{current}\n\n{block}" if current else block
            if current and unit_length(candidate, len_unit) <= cap:
                current = candidate
                continue
            if current:
                pieces.append(current)
            current = block
            continue
        for piece in _split_block(block, cap, len_unit):
            candidate = f"{current}\n\n{piece}" if current else piece
            if current and unit_length(candidate, len_unit) <= cap:
                current = candidate
                continue
            if current:
                pieces.append(current)
            current = piece
    if current:
        pieces.append(current)
    return pieces


def _paragraphs(text: str) -> list[str]:
    """Blank-line segments; blank lines inside ``` fences never split."""
    blocks: list[str] = []
    current: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            current.append(line)
            continue
        if not in_fence and not line.strip():
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def _split_block(block: str, cap: int, len_unit: str) -> list[str]:
    if unit_length(block, len_unit) <= cap:
        return [block]
    pieces: list[str] = []
    current = ""
    for part in _SENTENCE_BOUNDARY.split(block):
        part = part.lstrip("\n")
        if not part:
            continue
        for piece in _hard_cut(part, cap, len_unit) if unit_length(part, len_unit) > cap else [part]:
            candidate = f"{current}{piece}" if current else piece
            if current and unit_length(candidate, len_unit) > cap:
                pieces.append(current)
                current = piece
                continue
            current = candidate
    if current:
        pieces.append(current)
    return pieces


def _hard_cut(text: str, cap: int, len_unit: str) -> list[str]:
    """Cut an unbreakable run at the cap, never inside a surrogate pair.

    Python strings iterate by codepoint, so cutting only ever lands between
    full codepoints; utf16 accounting simply charges 2 units to astral chars.
    """
    pieces: list[str] = []
    current: list[str] = []
    used = 0
    for char in text:
        size = 2 if len_unit == "utf16" and ord(char) > 0xFFFF else 1
        if current and used + size > cap:
            pieces.append("".join(current))
            current = []
            used = 0
        current.append(char)
        used += size
    if current:
        pieces.append("".join(current))
    return pieces


# --- markdown degrade (markdown == "none" channels) --------------------------


def degrade_markdown(text: str) -> str:
    """Strip markdown for plain-text channels; fences become 4-space blocks."""
    lines: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            lines.append(f"    {line}" if line.strip() else "")
            continue
        stripped = line.lstrip()
        if stripped.startswith("#"):
            stripped = stripped.lstrip("#").strip()
        lines.append(_degrade_inline(stripped))
    return "\n".join(lines).strip("\n")


def _degrade_inline(text: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\(([^)]*)\)", r"\1", text)  # links keep label
    text = text.replace("**", "").replace("__", "")
    return text


# --- choices rendering -------------------------------------------------------


def render_choices(choices: tuple[str, ...] | list[str]) -> str:
    """``1. 选项`` lines + blank line + 回复数字即可; >5 truncates with a note."""
    labels = list(choices[:CHOICE_LIMIT])
    hidden = len(choices) - len(labels)
    lines = [f"{index}. {label}" for index, label in enumerate(labels, 1)]
    if hidden > 0:
        lines.append(f"（其余 {hidden} 项略）")
    lines.append("")
    lines.append("回复数字即可")
    return "\n".join(lines)


__all__ = ["TITLE_RESERVE", "degrade_markdown", "first_line_title", "render_choices", "split_text", "unit_length"]
