"""/skill: every Skill layer of the conversation, what wins, and what failed to load."""

from __future__ import annotations

from agent.domain.skills import IMPORT_SOURCES
from agent.infrastructure.persistence.session_meta import normalize_skill_sources
from agent.infrastructure.skills import ScannedSource, SkillScan
from agent.runtime.server.commands.contracts import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def scan_skills(context: SlashCommandContext) -> SkillScan:
    """The conversation's chosen layers; before its first message, the window's choice."""
    if context.session.session_id:
        imports = await context.session.get_skill_sources()
    else:
        imports = normalize_skill_sources((context.draft or {}).get("skill_sources"))
    return context.skills.scan(imports)


async def handle_skill(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args:
        return "Usage: /skill"
    scan = await scan_skills(context)
    effective = scan.effective()
    sources = [_source_display(scanned, effective) for scanned in scan.sources]
    problems = [
        {"location": problem.location, "message": problem.message}
        for scanned in scan.sources if scanned.enabled
        for problem in scanned.problems
    ]
    display = {"type": "skills", "sources": sources, "problems": problems}
    return SlashCommandResult(_skills_text(sources, problems), display=display)


def _source_display(scanned: ScannedSource, effective: dict) -> dict:
    return {
        "label": scanned.source.label,
        "paths": [str(path) for path in scanned.source.paths],
        "enabled": scanned.enabled,
        "importable": scanned.source.id in IMPORT_SOURCES,
        "skills": [_skill_display(skill, scanned.enabled, effective) for skill in scanned.skills],
    }


def _skill_display(skill, enabled: bool, effective: dict) -> dict:
    winner = effective.get(skill.name.lower())
    if not enabled:
        status = "off"
    elif winner is not None and winner.location != skill.location:
        status = "overridden"
    else:
        status = "active" if skill.model_invocable else "hidden"
    entry = {"name": skill.name, "description": skill.description, "status": status}
    if status == "overridden":
        entry["overridden_by"] = winner.location
    return entry


def _skills_text(sources: list[dict], problems: list[dict]) -> str:
    lines: list[str] = []
    for source in sources:
        paths = " · ".join(source["paths"])
        if not source["enabled"]:
            lines.append(f"{source['label']}  off  {paths} · {len(source['skills'])} skill(s)  (/import to enable)")
            continue
        if not source["skills"]:
            continue
        lines.append(f"{source['label']}  {paths}")
        for skill in source["skills"]:
            note = {
                "active": skill["description"],
                "hidden": f"hidden from the model · {skill['description']}",
                "overridden": f"overridden by {skill.get('overridden_by', '')}",
            }[skill["status"]]
            lines.append(f"  {skill['name']}  {note}")
    if problems:
        lines.append("Problems")
        lines.extend(f"  {problem['location']}  {problem['message']}" for problem in problems)
    return "\n".join(lines) if lines else "No skills found."


COMMAND = SlashCommandInfo(
    name="skill",
    description="List skills and where they come from",
    usage="/skill",
    handler=handle_skill,
)
