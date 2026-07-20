"""Markdown rendering helpers for CLI output."""

from __future__ import annotations

import re

from rich.console import Console
from rich.markdown import Markdown

_console = Console()


def _normalize_markdown(text: str) -> str:
    normalized = text.replace("\r\n", "\n").strip("\n")
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    # Rich renders top-level headings with strong centering/rule styles.
    # Downgrade headings to bold lines for denser CLI readability.
    normalized = re.sub(r"^(#{1,3})\s+(.+?)\s*$", r"**\2**", normalized, flags=re.MULTILINE)
    return normalized


def markdown_renderable(text: str) -> Markdown:
    """Build a Markdown renderable with CLI-friendly normalization."""
    return Markdown(_normalize_markdown(text))


def render_markdown(text: str) -> None:
    """Render markdown text to terminal using rich."""
    _console.print(markdown_renderable(text))
