"""/import: choose which Claude and Codex Skill layers this conversation reads."""

from __future__ import annotations

from agent.domain.skills import IMPORT_SOURCES
from agent.runtime.server.commands.contracts import SlashCommandContext, SlashCommandInfo, SlashCommandResult
from agent.runtime.server.commands.skill import scan_skills


USAGE = "/import [<source>=on|off ...]   sources: " + ", ".join(IMPORT_SOURCES)
APPLIES = "This breaks the prompt cache: the next model request will not hit it."


async def handle_import(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    changes = _parse_changes(args)
    if changes is None:
        return f"Usage: {USAGE}"
    if changes:
        if not context.session.session_id:
            return "/import <source>=on|off changes a conversation. Send your first message to start one."
        current = await context.session.get_skill_sources()
        await context.session.set_skill_sources({**current, **changes})
        if context.runtime is not None:
            await context.runtime.sync_skill_catalog()
    scan = await scan_skills(context)
    sources = [
        {
            "id": scanned.source.id,
            "label": scanned.source.label,
            "paths": [str(path) for path in scanned.source.paths],
            "count": len(scanned.skills),
            "enabled": scanned.enabled,
        }
        for scanned in scan.sources if scanned.source.id in IMPORT_SOURCES
    ]
    lines = [f"[{'x' if source['enabled'] else ' '}] {source['id']}  {' · '.join(source['paths'])}  {source['count']} skill(s)" for source in sources]
    text = "\n".join(([f"Skill imports updated. {APPLIES}"] if changes else []) + lines + ([] if changes else [f"Usage: {USAGE}"]))
    return SlashCommandResult(text, display={"type": "skill_imports", "sources": sources})


def _parse_changes(args: list[str]) -> dict[str, bool] | None:
    changes: dict[str, bool] = {}
    for arg in args:
        source, separator, value = arg.partition("=")
        if not separator or source not in IMPORT_SOURCES or value not in {"on", "off"}:
            return None
        changes[source] = value == "on"
    return changes


COMMAND = SlashCommandInfo(
    name="import",
    description="Choose the Claude and Codex skills this conversation reads",
    usage=USAGE,
    handler=handle_import,
)
