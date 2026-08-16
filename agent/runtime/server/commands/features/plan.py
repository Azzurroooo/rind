"""Plan summary slash command."""

from ..router import SlashCommandContext, SlashCommandInfo


async def handle_plan(context: SlashCommandContext, args: list[str]) -> str:
    try:
        from agent.infrastructure.planning.store import load_plan_if_exists
        from agent.infrastructure.planning.summary import render_plan_summary

        plan = load_plan_if_exists()
        summary = render_plan_summary(plan or [])
    except FileNotFoundError:
        summary = ""
    except Exception as exc:
        return f"Command failed: {exc}"
    return summary or "No active plan."


COMMAND = SlashCommandInfo(
    name="plan",
    description="Show active plan summary",
    usage="/plan",
    handler=handle_plan,
)
