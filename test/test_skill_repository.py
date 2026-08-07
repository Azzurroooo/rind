import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.skills import SkillMetadata
from agent.infrastructure.skills import SkillRepository


def _write_skill(root: Path, name: str, description: str, body: str = "Body") -> Path:
    skill_file = root / name / "SKILL.md"
    skill_file.parent.mkdir(parents=True)
    skill_file.write_text(
        f"---\nname: {name}\ndescription: {description}\ntriggers: [legacy]\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return skill_file


def test_skill_repository_scans_metadata_and_applies_scope_overrides(tmp_path: Path, monkeypatch) -> None:
    user = tmp_path / "user"
    project = tmp_path / "project"
    agent = tmp_path / "agent"
    _write_skill(user, "shared", "user version", "user body")
    _write_skill(project, "shared", "project version", "project body")
    _write_skill(agent, "shared", "agent version", "agent body")
    _write_skill(project, "project-only", "project only")

    repository = SkillRepository(
        user_skill_dir=str(user),
        project_skill_dir=str(project),
        agent_skill_dir=str(agent),
    )
    monkeypatch.setattr(
        "agent.infrastructure.skills.repository.parse_skill_markdown",
        lambda *args, **kwargs: pytest.fail("metadata scan must not load skill bodies"),
    )

    skills = repository.list_skills()

    assert [(skill.name, skill.scope, skill.description) for skill in skills] == [
        ("project-only", "project", "project only"),
        ("shared", "agent", "agent version"),
    ]


def test_skill_repository_loads_full_body_only_on_demand(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    skill_file = _write_skill(root, "demo", "Demo skill", "# Demo\nUse the full body.")
    repository = SkillRepository(project_skill_dir=str(root), user_skill_dir=str(tmp_path / "user"))

    metadata = repository.get_skill("DEMO")
    loaded = repository.load_skill("demo")

    assert metadata is not None
    assert metadata.scope == "project"
    assert metadata.path == str(skill_file)
    assert loaded is not None
    assert loaded.body == "# Demo\nUse the full body."


def test_skill_repository_excludes_invalid_frontmatter_and_nested_skills(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    _write_skill(root / "group", "nested", "must not be discovered")
    mismatched = root / "wrong" / "SKILL.md"
    mismatched.parent.mkdir(parents=True)
    mismatched.write_text("---\nname: other\ndescription: Wrong\n---\n\nBody\n", encoding="utf-8")
    missing_description = root / "missing" / "SKILL.md"
    missing_description.parent.mkdir(parents=True)
    missing_description.write_text("---\nname: missing\n---\n\nBody\n", encoding="utf-8")

    repository = SkillRepository(project_skill_dir=str(root), user_skill_dir=str(tmp_path / "user"))

    assert repository.list_skills() == []
    assert repository.load_skill("nested") is None


def test_skill_repository_rejects_empty_body_when_loading(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    _write_skill(root, "empty", "Empty", "")
    repository = SkillRepository(project_skill_dir=str(root), user_skill_dir=str(tmp_path / "user"))

    assert repository.get_skill("empty") is not None
    with pytest.raises(ValueError, match="body cannot be empty"):
        repository.load_skill("empty")


def test_skill_repository_does_not_load_a_metadata_path_outside_its_scope(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "skills"
    outside = _write_skill(tmp_path / "outside", "escaped", "Escaped")
    repository = SkillRepository(project_skill_dir=str(root), user_skill_dir=str(tmp_path / "user"))
    metadata = SkillMetadata(name="escaped", description="Escaped", path=str(outside), scope="project")
    monkeypatch.setattr(repository, "get_skill", lambda _name: metadata)

    with pytest.raises(ValueError, match="scope root"):
        repository.load_skill("escaped")
