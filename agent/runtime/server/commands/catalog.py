"""Built-in slash command catalog."""

from __future__ import annotations

from agent.runtime.server.commands.compact import COMMAND as COMPACT_COMMAND
from agent.runtime.server.commands.help import build_help_command
from agent.runtime.server.commands.init_rind_doc import COMMAND as INIT_COMMAND
from agent.runtime.server.commands.model import COMMAND as MODEL_COMMAND
from agent.runtime.server.commands.sessions import COMMAND as SESSIONS_COMMAND
from agent.runtime.server.commands.skill import COMMAND as SKILL_COMMAND
from agent.runtime.server.commands.status import COMMAND as STATUS_COMMAND
from agent.runtime.server.commands.team import COMMAND as TEAM_COMMAND
from agent.runtime.server.commands.contracts import SlashCommandInfo


def build_command_infos() -> tuple[SlashCommandInfo, ...]:
    commands: list[SlashCommandInfo] = []
    commands.append(build_help_command(lambda: tuple(commands)))
    commands.extend(
        (
            STATUS_COMMAND,
            TEAM_COMMAND,
            SESSIONS_COMMAND,
            SKILL_COMMAND,
            INIT_COMMAND,
            COMPACT_COMMAND,
            MODEL_COMMAND,
        )
    )
    return tuple(commands)


__all__ = ["build_command_infos"]
