"""Filesystem-backed Skill discovery across Rind, Claude and Codex folders."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
from pathlib import Path
import shutil
import uuid

from filelock import FileLock

from agent.domain.skills import LoadedSkill, SkillMetadata, parse_skill_metadata, split_frontmatter
from agent.infrastructure.paths import resolve_rind_home


BUNDLED_SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"
SYSTEM_SKILLS = ".system"
BUNDLE_MARKER = ".bundle"


@dataclass(frozen=True, slots=True)
class SkillSource:
    """Skill folders (or assigned SKILL.md files) read as one layer, in precedence order."""

    id: str
    label: str
    paths: tuple[Path, ...]


@dataclass(frozen=True, slots=True)
class SkillProblem:
    location: str
    message: str


@dataclass(frozen=True, slots=True)
class ScannedSource:
    source: SkillSource
    enabled: bool
    skills: tuple[SkillMetadata, ...]
    problems: tuple[SkillProblem, ...]


@dataclass(frozen=True, slots=True)
class SkillScan:
    sources: tuple[ScannedSource, ...]

    def effective(self) -> dict[str, SkillMetadata]:
        """Skills by lowercase name; a later enabled layer overrides an earlier one."""
        skills: dict[str, SkillMetadata] = {}
        for scanned in self.sources:
            if scanned.enabled:
                skills.update((skill.name.lower(), skill) for skill in scanned.skills)
        return skills


class SkillRepository:
    """Scan every Skill layer of one workspace; ``imports`` switches the Claude and Codex layers."""

    def __init__(
        self,
        workspace: str | Path,
        *,
        home: str | Path | None = None,
        rind_home: str | Path | None = None,
        skill_files: tuple[str, ...] = (),
    ):
        project = Path(workspace).expanduser().resolve()
        user = Path(home).expanduser().resolve() if home else Path.home()
        rind = Path(rind_home).expanduser().resolve() if rind_home else resolve_rind_home()
        self._sources = (
            SkillSource("builtin", "Rind · built-in", (rind / "skills" / SYSTEM_SKILLS,)),
            SkillSource("claude_user", "Claude · user", (user / ".claude" / "skills",)),
            SkillSource("codex_user", "Codex · user", (user / ".codex" / "skills", user / ".agents" / "skills")),
            SkillSource("rind_user", "Rind · user", (rind / "skills",)),
            SkillSource("claude_project", "Claude · project", (project / ".claude" / "skills",)),
            SkillSource("codex_project", "Codex · project", (project / ".codex" / "skills", project / ".agents" / "skills")),
            SkillSource("rind_project", "Rind · project", (project / ".rind" / "skills",)),
            SkillSource("agent", "Team", tuple(Path(file).resolve() for file in skill_files)),
        )

    def scan(self, imports: Mapping[str, bool]) -> SkillScan:
        return SkillScan(tuple(
            ScannedSource(source, imports.get(source.id, True), *_scan_source(source))
            for source in self._sources
        ))

    def list_skills(self, imports: Mapping[str, bool]) -> list[SkillMetadata]:
        return sorted(self.scan(imports).effective().values(), key=lambda skill: skill.name.lower())

    def load_skill(self, name: str, imports: Mapping[str, bool]) -> LoadedSkill | None:
        metadata = self.scan(imports).effective().get(str(name or "").strip().lower())
        if metadata is None:
            return None
        _frontmatter, body = split_frontmatter(Path(metadata.location).read_text(encoding="utf-8", errors="replace"))
        return LoadedSkill(metadata=metadata, body=body)


def _scan_source(source: SkillSource) -> tuple[tuple[SkillMetadata, ...], tuple[SkillProblem, ...]]:
    skills: list[SkillMetadata] = []
    problems: list[SkillProblem] = []
    for path in source.paths:
        for file in _skill_files(path):
            try:
                text = file.read_text(encoding="utf-8", errors="replace")
                metadata, warning = parse_skill_metadata(text, str(file.resolve()), file.parent.name, source.id)
            except (OSError, ValueError) as exc:
                problems.append(SkillProblem(str(file), str(exc)))
                continue
            skills.append(metadata)
            if warning:
                problems.append(SkillProblem(str(file), warning))
    if source.id == "builtin" and not skills and not problems:
        problems.append(SkillProblem(str(source.paths[0]), "built-in skills are missing; restart Rind or reinstall it."))
    return tuple(skills), tuple(problems)


def install_system_skills(rind_home: Path, bundled: Path = BUNDLED_SKILLS_DIR) -> None:
    """Mirror the skills shipped with Rind into RIND_HOME/skills/.system when their content changed.

    Readers see the old copy or the new one, never a half-written mix: the new
    copy is staged beside it and swapped in by renaming. Raises OSError.
    """
    skills = rind_home / "skills"
    target = skills / SYSTEM_SKILLS
    fingerprint = _fingerprint(bundled)
    if _installed_fingerprint(target) == fingerprint:
        return
    skills.mkdir(parents=True, exist_ok=True)
    with FileLock(str(skills / f"{SYSTEM_SKILLS}.lock"), timeout=10):
        if _installed_fingerprint(target) == fingerprint:
            return
        staged = skills / f"{SYSTEM_SKILLS}-{uuid.uuid4().hex}"
        shutil.copytree(bundled, staged)
        (staged / BUNDLE_MARKER).write_text(fingerprint, encoding="utf-8")
        if target.exists():
            target.rename(skills / f"{SYSTEM_SKILLS}-retired-{uuid.uuid4().hex}")
        staged.rename(target)
        for leftover in skills.glob(f"{SYSTEM_SKILLS}-*"):
            shutil.rmtree(leftover, ignore_errors=True)


def _fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(path for path in root.rglob("*") if path.is_file()):
        digest.update(file.relative_to(root).as_posix().encode() + b"\0" + file.read_bytes() + b"\0")
    return digest.hexdigest()


def _installed_fingerprint(target: Path) -> str:
    try:
        return (target / BUNDLE_MARKER).read_text(encoding="utf-8")
    except OSError:
        return ""


def _skill_files(path: Path) -> list[Path]:
    """An assigned SKILL.md itself, or each visible `<name>/SKILL.md` below a Skill folder."""
    if path.name == "SKILL.md":
        return [path]
    try:
        children = sorted(path.iterdir(), key=lambda child: child.name.lower())
    except OSError:
        return []
    return [
        child / "SKILL.md"
        for child in children
        if not child.name.startswith(".") and (child / "SKILL.md").is_file()
    ]
