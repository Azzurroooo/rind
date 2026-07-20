"""Filesystem-backed Tangerine Rind skill repository."""

from __future__ import annotations

from pathlib import Path

from agent.domain.skills import Skill, parse_skill_markdown
from agent.infrastructure.paths import resolve_tangerine_home, resolve_project_root


class SkillRepository:
    """Discovers project and user SKILL.md files."""

    def __init__(
        self,
        project_root: str | None = None,
        user_home: str | None = None,
        project_skill_dir: str | None = None,
        user_skill_dir: str | None = None,
    ):
        project_base = Path(project_root).expanduser().resolve() if project_root else resolve_project_root()
        user_base = Path(user_home).expanduser().resolve() / ".tangerine" if user_home else resolve_tangerine_home()
        self._project_skill_dir = Path(project_skill_dir).expanduser().resolve() if project_skill_dir else project_base / ".tangerine" / "skills"
        self._user_skill_dir = Path(user_skill_dir).expanduser().resolve() if user_skill_dir else user_base / "skills"

    def list_skills(self) -> list[Skill]:
        skills_by_name: dict[str, Skill] = {}
        for skill in self._scan_dir(self._user_skill_dir, source="user"):
            skills_by_name[skill.name.lower()] = skill
        for skill in self._scan_dir(self._project_skill_dir, source="project"):
            skills_by_name[skill.name.lower()] = skill
        return sorted(skills_by_name.values(), key=lambda item: item.name.lower())

    def get_skill(self, name: str) -> Skill | None:
        target = name.lower()
        for skill in self.list_skills():
            if skill.name.lower() == target:
                return skill
        return None

    def _scan_dir(self, root: Path, source: str) -> list[Skill]:
        if not root.is_dir():
            return []

        skills: list[Skill] = []
        for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if not child.is_dir():
                continue
            skill_file = child / "SKILL.md"
            if not skill_file.is_file():
                continue
            try:
                text = skill_file.read_text(encoding="utf-8", errors="replace")
                skills.append(
                    parse_skill_markdown(
                        text=text,
                        path=str(skill_file),
                        fallback_name=child.name,
                        source=source,
                    )
                )
            except Exception:
                continue
        return skills
