"""Help slash command."""

from __future__ import annotations

from collections.abc import Callable

from agent.runtime.server.commands.contracts import SlashCommandContext, SlashCommandInfo, SlashCommandResult


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


HELP_GROUPS = (
    ("Operate", ("status", "plan", "draft", "compact")),
    ("Explore", ("sessions", "skill", "help")),
    ("Configure", ("model", "login")),
)


def render_help(command_infos: tuple[SlashCommandInfo, ...]) -> str:
    by_name = {info.name: info for info in command_infos}
    command_width = max((len(info.name) for info in command_infos), default=0)
    used: set[str] = set()
    body = ["```text"]
    for title, names in HELP_GROUPS:
        rows = [by_name[name] for name in names if name in by_name]
        if not rows:
            continue
        if len(body) > 1:
            body.append("")
        body.append(title)
        body.extend(_format_help_row(info, command_width) for info in rows)
        used.update(info.name for info in rows)
    remaining = [info for info in command_infos if info.name not in used]
    if remaining:
        if len(body) > 1:
            body.append("")
        body.append("Other")
        body.extend(_format_help_row(info, command_width) for info in remaining)
    body.append("```")
    return "\n".join(["# Commands", "", *body, "", "Use `/help <command>` for usage."])


def render_command_help(command_infos: tuple[SlashCommandInfo, ...], command: str) -> str:
    name = command.strip().lstrip("/").lower()
    info = _find_command_info(command_infos, name)
    if info is None:
        return f"Unknown command: /{name}\nRun /help to see available commands."
    lines = [
        f"# /{info.name}",
        "",
        info.description,
        "",
        "```text",
        "Usage",
        f"  {info.usage or '/' + info.name}",
    ]
    if info.aliases:
        lines.extend(["", "Aliases", f"  {_format_aliases(info.aliases)}"])
    lines.append("```")
    return "\n".join(lines)


def _format_help_row(info: SlashCommandInfo, command_width: int) -> str:
    suffix = f" ({_alias_label(info.aliases)}: {_format_aliases(info.aliases)})" if info.aliases else ""
    return f"  /{info.name:<{command_width}}  {info.description}{suffix}"


def _alias_label(aliases: tuple[str, ...]) -> str:
    return "alias" if len(aliases) == 1 else "aliases"


def _format_aliases(aliases: tuple[str, ...]) -> str:
    return ", ".join(f"/{alias}" for alias in aliases)
