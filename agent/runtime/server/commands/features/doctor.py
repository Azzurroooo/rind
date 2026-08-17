"""Doctor slash command."""

import asyncio

from ..diagnostics import build_doctor_report
from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_doctor(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args:
        return "Usage: /doctor"
    report = await asyncio.to_thread(build_doctor_report, context)
    return SlashCommandResult(report.text, display=report.display)


COMMAND = SlashCommandInfo(
    name="doctor",
    description="Run local setup diagnostics",
    usage="/doctor",
    handler=handle_doctor,
)
