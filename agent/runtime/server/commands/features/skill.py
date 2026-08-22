"""Skill list slash command."""

from pathlib import Path

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


async def handle_skill(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args and args[0].lower() != "list":
        return "Usage: /skill or /skill list"
    try:
        repository = getattr(context.runtime, "skill_repository", None)
        if repository is None:
            from agent.infrastructure.skills.repository import SkillRepository

            repository = SkillRepository(project_root=context.workspace_root or str(Path.cwd()))
        skills = repository.list_skills()
    except Exception as exc:
        return f"Command failed: {exc}"
    if not skills:
        return SlashCommandResult("No skills found.", display={"type": "skills", "skills": []})
    lines = ["Skills:"]
    display_skills = []
    for skill in skills:
        description = str(getattr(skill, "description", "") or "").strip()
        path = str(getattr(skill, "path", "") or "")
        scope = str(getattr(skill, "scope", "") or "")
        lines.append(f"- {skill.name} [{scope}] {description} ({path})")
        display_skills.append(
            {
                "name": str(getattr(skill, "name", "") or ""),
                "scope": scope,
                "description": description,
                "path": path,
            }
        )
    return SlashCommandResult("\n".join(lines), display={"type": "skills", "skills": display_skills})


COMMAND = SlashCommandInfo(
    name="skill",
    description="List skills",
    usage="/skill [list]",
    handler=handle_skill,
)
