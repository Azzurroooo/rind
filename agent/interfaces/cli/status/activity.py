"""Human-readable summaries for tool activity lines."""

from __future__ import annotations

import json
from typing import Any

from agent.interfaces.cli.formatting import clip_text, single_line


def tool_activity_summary(tool_name: str, args_preview: str = "", *, max_len: int = 120) -> str:
    name = str(tool_name or "unknown").strip() or "unknown"
    args = _parse_args(args_preview)
    detail = _tool_detail(name, args) if args else ""
    if not detail:
        return name
    return f"{name}: {clip_text(detail, max_len)}"


def _parse_args(value: str) -> dict[str, Any]:
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _tool_detail(name: str, args: dict[str, Any]) -> str:
    if name == "bash":
        return single_line(args.get("command"))
    if name == "bash_output":
        bg_id = single_line(args.get("bg_id"))
        return f"bg {bg_id}" if bg_id else ""
    if name in {"read_file", "write_file", "edit_file"}:
        return single_line(args.get("file_path"))
    if name == "glob":
        pattern = single_line(args.get("pattern"))
        path = single_line(args.get("path"))
        return f"{pattern} in {path or '.'}" if pattern else path
    if name == "grep":
        pattern = single_line(args.get("pattern"))
        path = single_line(args.get("path")) or "."
        return f"{pattern} in {path}" if pattern else path
    if name == "list_files":
        return single_line(args.get("directory")) or single_line(args.get("pattern"))
    for key in ("path", "file_path", "query", "url", "command"):
        value = single_line(args.get(key))
        if value:
            return value
    return ""
