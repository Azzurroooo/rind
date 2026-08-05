"""Saved input draft slash command."""

from pathlib import Path

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_draft(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if len(args) > 1 or (args and args[0].lower() not in {"use", "clear"}):
        return "Usage: /draft, /draft use, or /draft clear"
    path = _draft_path(context.session)
    if args and args[0].lower() == "clear":
        return _clear_draft(path)
    if args and args[0].lower() == "use":
        draft = _read_draft(path)
        if draft is None:
            return "No saved input draft."
        return SlashCommandResult("Draft loaded into the next prompt.", input_prefill=draft)
    if path is None or not path.exists():
        return "No saved input draft."
    draft = _read_draft(path)
    if draft is None:
        return "No saved input draft."
    return f"Saved input draft: {path}\n\n{draft}"


def _draft_path(session) -> Path | None:
    base = _session_base_path(session)
    return base / "input_draft.txt" if base else None


def _clear_draft(path: Path | None) -> str:
    if path is None or not path.exists():
        return "No saved input draft."
    try:
        path.unlink()
    except Exception as exc:
        return f"Command failed: {exc}"
    return "Saved input draft cleared."


def _read_draft(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    try:
        draft = path.read_text(encoding="utf-8").strip()
    except Exception:
        return None
    return draft or None


def _session_base_path(session) -> Path | None:
    paths = getattr(session, "_session_paths", None)
    if isinstance(paths, dict) and paths.get("base"):
        return Path(str(paths["base"]))
    root = getattr(session, "_session_root", None)
    session_id = getattr(session, "session_id", None)
    if root and session_id:
        return Path(str(root)) / str(session_id)
    return None


COMMAND = SlashCommandInfo(
    name="draft",
    description="Show, reuse, or clear saved input draft",
    usage="/draft | /draft use | /draft clear",
    handler=handle_draft,
)
