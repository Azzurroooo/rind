import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain import parse_skill_markdown
from agent.infrastructure.skills import SkillRepository
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin.skill import skill, skill_create


def _payload(result: str) -> dict:
    return json.loads(result)


def _repository(tmp_path: Path, *, agent: bool = False) -> SkillRepository:
    return SkillRepository(
        user_skill_dir=str(tmp_path / "user" / "skills"),
        project_skill_dir=str(tmp_path / "project" / ".rind" / "skills"),
        agent_skill_dir=str(tmp_path / "agent" / ".aiteam" / "skills") if agent else None,
    )


def test_skill_create_writes_standard_project_package(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    result = _payload(
        skill_create(
            name="demo-skill",
            description="Demo skill.",
            body="# Demo\nFollow these instructions.",
            _repository=repository,
        )
    )

    skill_file = tmp_path / "project" / ".rind" / "skills" / "demo-skill" / "SKILL.md"
    assert result["ok"] is True
    assert Path(result["data"]["path"]) == skill_file
    assert skill_file.exists()
    assert not (skill_file.parent / "references").exists()
    parsed = parse_skill_markdown(skill_file.read_text(encoding="utf-8"), str(skill_file), "demo-skill", "project")
    assert parsed.name == "demo-skill"
    assert parsed.description == "Demo skill."
    assert parsed.body == "# Demo\nFollow these instructions."
    assert "triggers" not in skill_file.read_text(encoding="utf-8")


def test_skill_tool_loads_effective_skill_and_returns_package_location(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    created = _payload(skill_create("demo", "Demo", "Use this workflow.", _repository=repository))
    assert created["ok"] is True

    result = _payload(skill("demo", _repository=repository))

    assert result["ok"] is True
    data = result["data"]
    assert data["scope"] == "project"
    assert data["base_directory"] == str(Path(data["path"]).parent)
    assert '<skill_content name="demo" scope="project">' in data["content"]
    assert "Use this workflow." in data["content"]


def test_skill_create_agent_scope_requires_team_agent_root(tmp_path: Path) -> None:
    unavailable = _payload(skill_create("demo", "Demo", "Body", scope="agent", _repository=_repository(tmp_path)))
    available = _payload(skill_create("demo", "Demo", "Body", scope="agent", _repository=_repository(tmp_path, agent=True)))

    assert unavailable["ok"] is False
    assert unavailable["error_type"] == "InvalidScope"
    assert available["ok"] is True
    assert available["data"]["scope"] == "agent"


def test_skill_create_rejects_invalid_names_and_preserves_overwrite_policy(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    invalid = _payload(skill_create("bad/name", "Demo", "Body", _repository=repository))
    first = _payload(skill_create("demo", "First", "First body", _repository=repository))
    duplicate = _payload(skill_create("demo", "Second", "Second body", _repository=repository))
    overwritten = _payload(skill_create("demo", "Second", "Second body", overwrite=True, _repository=repository))

    assert invalid["error_type"] == "InvalidSkillName"
    assert first["ok"] is True
    assert duplicate["error_type"] == "SkillAlreadyExists"
    assert overwritten["ok"] is True


def test_skill_tools_are_registered_with_agent_scope() -> None:
    registry = DefaultToolRegistry()
    assert registry.has("skill")
    assert registry.has("skill_create")
    create_schema = next(schema for schema in registry.schemas if schema["function"]["name"] == "skill_create")
    assert create_schema["function"]["parameters"]["properties"]["scope"]["enum"] == [
        "project",
        "user",
        "agent",
    ]
