"""Help text rendering for CLI slash commands."""

from __future__ import annotations

from .router import SlashCommandInfo


HELP_GROUPS = (
    ("Operate", ("status", "plan", "draft", "compact")),
    ("Explore", ("sessions", "skill", "help")),
    ("Configure", ("model", "config", "doctor", "login")),
    ("Terminal", ("clear", "exit")),
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


def _find_command_info(command_infos: tuple[SlashCommandInfo, ...], name: str) -> SlashCommandInfo | None:
    for info in command_infos:
        if info.name == name or name in info.aliases:
            return info
    return None
