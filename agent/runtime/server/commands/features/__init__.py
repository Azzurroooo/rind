"""Built-in slash command catalog."""

from __future__ import annotations

from .compact import COMMAND as COMPACT_COMMAND
from .config import COMMAND as CONFIG_COMMAND
from .doctor import COMMAND as DOCTOR_COMMAND
from .help import build_help_command
from .init import COMMAND as INIT_COMMAND
from .login import COMMAND as LOGIN_COMMAND
from .model import COMMAND as MODEL_COMMAND
from .sessions import COMMAND as SESSIONS_COMMAND
from .skill import COMMAND as SKILL_COMMAND
from .status import COMMAND as STATUS_COMMAND
from .team import COMMAND as TEAM_COMMAND
from ..router import SlashCommandInfo


def build_command_infos() -> tuple[SlashCommandInfo, ...]:
    commands: list[SlashCommandInfo] = []
    commands.append(build_help_command(lambda: tuple(commands)))
    commands.extend(
        (
            STATUS_COMMAND,
            TEAM_COMMAND,
            DOCTOR_COMMAND,
            SESSIONS_COMMAND,
            SKILL_COMMAND,
            INIT_COMMAND,
            COMPACT_COMMAND,
            MODEL_COMMAND,
            LOGIN_COMMAND,
            CONFIG_COMMAND,
        )
    )
    return tuple(commands)


__all__ = ["build_command_infos"]
