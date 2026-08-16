"""RIND.md initialization slash command."""

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_init(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if len(args) > 1:
        return SlashCommandResult("Usage: /init [project|user]")
    scope = args[0].lower() if args else "project"
    if scope not in {"project", "user"}:
        return SlashCommandResult("Usage: /init [project|user]")

    from agent.infrastructure.rind_docs import resolve_project_doc_path, resolve_user_doc_path
    from agent.prompts import build_rind_init_prompt

    target = resolve_project_doc_path() if scope == "project" else resolve_user_doc_path()
    prompt = build_rind_init_prompt(scope, str(target))
    return SlashCommandResult(
        text=f"Initializing {scope} RIND.md: {target}",
        run_turn_input=f"Initialize {scope} RIND.md at {target}",
        transient_system_messages=[
            {
                "role": "system",
                "content": prompt,
                "_context_kind": "rind_init",
            }
        ],
    )


COMMAND = SlashCommandInfo(
    name="init",
    description="Draft RIND.md",
    usage="/init [project|user]",
    handler=handle_init,
)
