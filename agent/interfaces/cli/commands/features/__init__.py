"""Built-in slash command catalog."""

from __future__ import annotations

from .clear import COMMAND as CLEAR_COMMAND
from .compact import COMMAND as COMPACT_COMMAND
from .config import COMMAND as CONFIG_COMMAND
from .doctor import COMMAND as DOCTOR_COMMAND
from .draft import COMMAND as DRAFT_COMMAND
from .exit import COMMAND as EXIT_COMMAND
from .help import build_help_command
from .init import COMMAND as INIT_COMMAND
from .login import COMMAND as LOGIN_COMMAND
from .model import COMMAND as MODEL_COMMAND
from .plan import COMMAND as PLAN_COMMAND
from .sessions import COMMAND as SESSIONS_COMMAND
from .skill import COMMAND as SKILL_COMMAND
from .status import COMMAND as STATUS_COMMAND
from ..router import SlashCommandInfo


def build_command_infos() -> tuple[SlashCommandInfo, ...]:
    commands: list[SlashCommandInfo] = []
    commands.append(build_help_command(lambda: tuple(commands)))
    commands.extend(
        (
            STATUS_COMMAND,
            DOCTOR_COMMAND,
            SESSIONS_COMMAND,
            SKILL_COMMAND,
            INIT_COMMAND,
            PLAN_COMMAND,
            COMPACT_COMMAND,
            MODEL_COMMAND,
            CLEAR_COMMAND,
            DRAFT_COMMAND,
            LOGIN_COMMAND,
            CONFIG_COMMAND,
            EXIT_COMMAND,
        )
    )
    return tuple(commands)


__all__ = ["build_command_infos"]
