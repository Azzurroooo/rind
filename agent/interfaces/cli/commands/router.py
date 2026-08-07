"""Lightweight slash command router."""

from __future__ import annotations

import inspect
import shlex
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from agent.domain.cancellation import CancellationToken
from agent.application.skill_selection import SkillInvocationParser


@dataclass(slots=True)
class SlashCommandContext:
    runtime: Any
    session: Any
    debug: bool = False
    cancellation_token: CancellationToken | None = None


@dataclass(slots=True)
class SlashCommandResult:
    text: str = ""
    should_exit: bool = False
    clear_screen: bool = False
    input_prefill: str = ""
    run_turn_input: str = ""
    transient_system_messages: list[dict] | None = None
    context_usage_reset: bool = False
    display: dict[str, Any] | None = None


Handler = Callable[[SlashCommandContext, list[str]], str | SlashCommandResult | Awaitable[str | SlashCommandResult]]

@dataclass(frozen=True, slots=True)
class SlashCommandInfo:
    name: str
    description: str
    usage: str = ""
    aliases: tuple[str, ...] = ()
    handler: Handler | None = None


class SlashCommandRouter:
    """Parse and dispatch CLI slash commands."""

    def __init__(self, command_infos: Iterable[SlashCommandInfo] | None = None):
        if command_infos is None:
            from .features import build_command_infos

            command_infos = build_command_infos()
        self._skill_invocation_parser = SkillInvocationParser()
        self._command_infos = tuple(command_infos)
        self._commands_by_name: dict[str, SlashCommandInfo] = {}
        self._validate_commands()

    def command_names(self) -> list[str]:
        return sorted(self._commands_by_name)

    def command_infos(self) -> list[SlashCommandInfo]:
        return sorted(self._command_infos, key=lambda info: info.name)

    async def execute(self, raw_input: str, context: SlashCommandContext) -> SlashCommandResult:
        try:
            invocations = self._skill_invocation_parser.parse(raw_input or "")
            if invocations and invocations[0].syntax == "slash":
                return SlashCommandResult(run_turn_input=raw_input)
            name, args = self._parse(raw_input)
            info = self._commands_by_name.get(name)
            if info is None:
                return SlashCommandResult(f"Unknown command: /{name}\nRun /help to see available commands.")
            result = info.handler(context, args)
            if inspect.isawaitable(result):
                result = await result
            return result if isinstance(result, SlashCommandResult) else SlashCommandResult(str(result or ""))
        except ValueError as exc:
            return SlashCommandResult(f"Command failed: {exc}")
        except Exception as exc:
            return SlashCommandResult(f"Command failed: {exc}")

    def _validate_commands(self) -> None:
        names: set[str] = set()
        aliases: set[str] = set()
        for info in self._command_infos:
            if not isinstance(info, SlashCommandInfo):
                raise TypeError("Command catalog entries must be SlashCommandInfo instances.")
            name = info.name.strip().lower()
            if not name:
                raise ValueError("Command name must not be empty.")
            if not callable(info.handler):
                raise ValueError(f"Command handler is required: {name}")
            if name in names:
                raise ValueError(f"Duplicate command name: {name}")
            if name in aliases:
                raise ValueError(f"Command name conflicts with alias: {name}")
            names.add(name)
            self._commands_by_name[name] = info
            for alias in info.aliases:
                normalized_alias = str(alias).strip().lower()
                if not normalized_alias:
                    raise ValueError(f"Command alias must not be empty: {name}")
                if normalized_alias in names or normalized_alias in aliases:
                    raise ValueError(f"Duplicate command alias: {normalized_alias}")
                aliases.add(normalized_alias)
                self._commands_by_name[normalized_alias] = info

    def _parse(self, raw_input: str) -> tuple[str, list[str]]:
        text = raw_input.strip()
        if not text.startswith("/"):
            raise ValueError("Slash command must start with '/'.")
        try:
            parts = shlex.split(text[1:])
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if not parts:
            raise ValueError("Missing command name.")
        return parts[0].lower(), parts[1:]
