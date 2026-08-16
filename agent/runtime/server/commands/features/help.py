"""Help slash command."""

from __future__ import annotations

from collections.abc import Callable

from ..help_view import render_command_help, render_help
from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


def build_help_command(command_infos: Callable[[], tuple[SlashCommandInfo, ...]]) -> SlashCommandInfo:
    async def handle_help(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
        commands = command_infos()
        if len(args) > 1:
            return "Usage: /help [command]"
        if args:
            name = args[0].strip().lstrip("/").lower()
            info = _find_command_info(commands, name)
            text = render_command_help(commands, args[0])
            if info is None:
                return text
            return SlashCommandResult(
                text,
                display={"type": "help", "commands": _command_display_list(commands), "command": _command_display(info)},
            )
        return SlashCommandResult(
            render_help(commands),
            display={"type": "help", "commands": _command_display_list(commands)},
        )

    return SlashCommandInfo(
        name="help",
        description="Show commands",
        usage="/help [command]",
        handler=handle_help,
    )


def _command_display_list(command_infos: tuple[SlashCommandInfo, ...]) -> list[dict]:
    return [_command_display(info) for info in command_infos]


def _command_display(info: SlashCommandInfo) -> dict:
    return {
        "name": info.name,
        "description": info.description,
        "usage": info.usage,
        "aliases": list(info.aliases),
    }


def _find_command_info(command_infos: tuple[SlashCommandInfo, ...], name: str) -> SlashCommandInfo | None:
    return next((info for info in command_infos if info.name == name or name in info.aliases), None)
