"""Prompt-toolkit completer for slash commands."""

from __future__ import annotations

from collections.abc import Iterable

from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document


class SlashCommandCompleter(Completer):
    """Complete slash commands at the beginning of the current input."""

    def __init__(self, commands: Iterable[object]):
        entries: dict[str, str] = {}
        for command in commands:
            name = str(getattr(command, "name", command)).strip().lower()
            if not name:
                continue
            entries[name] = str(getattr(command, "description", "") or "").strip()
        self._commands = tuple(sorted(entries.items()))

    def get_completions(self, document: Document, complete_event):
        stripped = document.text_before_cursor.lstrip()
        if not stripped.startswith("/"):
            return

        if _is_help_argument(stripped):
            yield from self._complete_help_argument(stripped)
            return

        if _is_draft_argument(stripped):
            yield from self._complete_literal_arguments(stripped, ("clear", "use"))
            return

        if _has_command_args(stripped):
            return

        token = stripped[1:].lower()
        start_position = -len(stripped)
        yield from self._matching_commands(token, start_position=start_position, slash=True)

    def _complete_help_argument(self, stripped: str):
        parts = stripped.split(maxsplit=1)
        token = parts[1].lstrip("/").lower() if len(parts) > 1 else ""
        start_position = -len(token)
        yield from self._matching_commands(token, start_position=start_position, slash=False)

    def _complete_literal_arguments(self, stripped: str, values: tuple[str, ...]):
        parts = stripped.split(maxsplit=1)
        token = parts[1].lower() if len(parts) > 1 else ""
        for value in values:
            if value.startswith(token):
                yield Completion(value, start_position=-len(token), display=value)

    def _matching_commands(self, token: str, *, start_position: int, slash: bool):
        for command, description in self._commands:
            if command.startswith(token):
                yield Completion(
                    f"/{command}" if slash else command,
                    start_position=start_position,
                    display=f"/{command}" if slash else command,
                    display_meta=description,
                )


def _has_command_args(value: str) -> bool:
    parts = value.split(maxsplit=1)
    return len(parts) > 1


def _is_help_argument(value: str) -> bool:
    parts = value.split(maxsplit=1)
    return bool(parts) and parts[0].lower() == "/help" and (value.endswith(" ") or len(parts) > 1)


def _is_draft_argument(value: str) -> bool:
    parts = value.split(maxsplit=1)
    return bool(parts) and parts[0].lower() == "/draft" and (value.endswith(" ") or len(parts) > 1)
