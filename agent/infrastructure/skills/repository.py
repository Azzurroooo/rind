"""Filesystem-backed Rind Skill discovery and loading."""

from __future__ import annotations

from pathlib import Path

from agent.domain.skills import LoadedSkill, SkillMetadata, parse_skill_markdown, parse_skill_metadata
from agent.infrastructure.paths import resolve_project_root, resolve_rind_home


class SkillRepository:
    """Discover effective metadata and load Skill bodies on explicit demand."""

    def __init__(
        self,
        project_root: str | None = None,
        user_home: str | None = None,
        project_skill_dir: str | None = None,
        user_skill_dir: str | None = None,
        agent_skill_dir: str | None = None,
    ):
        project_base = Path(project_root).expanduser().resolve() if project_root else resolve_project_root()
        user_base = Path(user_home).expanduser().resolve() / ".rind" if user_home else resolve_rind_home()
        self._project_skill_dir = (
            Path(project_skill_dir).expanduser().resolve()
            if project_skill_dir
            else project_base / ".rind" / "skills"
        )
        self._user_skill_dir = (
            Path(user_skill_dir).expanduser().resolve()
            if user_skill_dir
            else user_base / "skills"
        )
        self._agent_skill_dir = Path(agent_skill_dir).expanduser().resolve() if agent_skill_dir else None

    def list_skills(self) -> list[SkillMetadata]:
        """Return effective metadata without loading Skill bodies."""
        skills_by_name: dict[str, SkillMetadata] = {}
        for root, scope in (
            (self._user_skill_dir, "user"),
            (self._project_skill_dir, "project"),
            (self._agent_skill_dir, "agent"),
        ):
            for skill in self._scan_dir(root, scope):
                skills_by_name[skill.name.lower()] = skill
        return sorted(skills_by_name.values(), key=lambda item: item.name.lower())

    def get_skill(self, name: str) -> SkillMetadata | None:
        target = str(name or "").strip().lower()
        if not target:
            return None
        return next((skill for skill in self.list_skills() if skill.name.lower() == target), None)

    def load_skill(self, name: str) -> LoadedSkill | None:
        """Load and validate one effective Skill body by name."""
        metadata = self.get_skill(name)
        if metadata is None:
            return None
        declared_file = Path(metadata.path)
        if declared_file.is_symlink():
            raise ValueError("SKILL.md must remain inside its Skill scope root.")
        root = self.skill_root(metadata.scope)
        skill_file = _ensure_within_root(declared_file, root)
        if skill_file.is_symlink() or not skill_file.is_file():
            raise ValueError("SKILL.md must remain inside its Skill scope root.")
        text = skill_file.read_text(encoding="utf-8", errors="replace")
        return parse_skill_markdown(
            text=text,
            path=metadata.path,
            fallback_name=skill_file.parent.name,
            scope=metadata.scope,
        )

    def skill_root(self, scope: str) -> Path:
        normalized = str(scope or "").strip().lower()
        roots = {
            "user": self._user_skill_dir,
            "project": self._project_skill_dir,
            "agent": self._agent_skill_dir,
        }
        root = roots.get(normalized)
        if root is None:
            if normalized == "agent":
                raise ValueError("Agent Skill scope requires an active Agent workspace.")
            raise ValueError("Skill scope must be user, project, or agent.")
        return root

    def _scan_dir(self, root: Path | None, scope: str) -> list[SkillMetadata]:
        if root is None or not root.is_dir():
            return []

        skills: list[SkillMetadata] = []
        seen: set[str] = set()
        for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if child.is_symlink() or not child.is_dir() or child.name.lower() in seen:
                continue
            try:
                resolved_child = _ensure_within_root(child, root)
            except ValueError:
                continue
            skill_file = child / "SKILL.md"
            if skill_file.is_symlink() or not skill_file.is_file():
                continue
            try:
                resolved_file = _ensure_within_root(skill_file, root)
            except ValueError:
                continue
            try:
                frontmatter = _read_frontmatter(skill_file)
                metadata = parse_skill_metadata(
                    text=frontmatter,
                    path=str(resolved_file),
                    fallback_name=resolved_child.name,
                    scope=scope,
                )
            except Exception:
                continue
            seen.add(metadata.name.lower())
            skills.append(metadata)
        return skills


def _read_frontmatter(path: Path) -> str:
    """Read only the frontmatter prefix; body validation belongs to ``load_skill``."""
    lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            lines.append(line)
            if len(lines) > 1 and line.rstrip("\r\n") == "---":
                break
    return "".join(lines)


def _ensure_within_root(path: Path, root: Path) -> Path:
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError(f"Skill path escapes its scope root: {path}") from exc
    return resolved_path
