"""Filesystem-only Team project tests."""

from __future__ import annotations

import shutil
import json
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.team import (
    WorkspaceBusyError,
    WorkspaceLock,
    discover_agent,
    initialize_team_project,
    initialize_team_agent,
    initialize_team_agents,
    list_agent_blueprints,
    list_team_agents,
    load_agent_capsule,
    load_team_project,
    materialize_team_agent,
    resolve_team_agent,
)
from agent.infrastructure.tools.builtin.files import build_file_tool_specs
from agent.infrastructure.tools.builtin.agent_create import create_agent_create_tool_spec


def test_initialize_team_project_creates_only_the_minimal_structure(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path, project_id="quant-project", name="Quant Project")
    main_agent = tmp_path / "agents" / "main-agent"

    assert project.project_id == "quant-project"
    assert project.main_agent == "main-agent"
    assert (tmp_path / ".aiteam" / "project.yaml").is_file()
    assert not (tmp_path / ".aiteam" / "organization.yaml").exists()
    assert (main_agent / ".aiteam" / "agent.yaml").is_file()
    assert (main_agent / ".aiteam" / "prompts" / "system.md").is_file()
    assert (main_agent / "memory").is_dir()
    assert (main_agent / "work").is_dir()
    assert (main_agent / "outputs").is_dir()
    assert (tmp_path / "shared").is_dir()
    assert not (tmp_path / "shared" / "artifacts").exists()
    assert not (main_agent / ".aiteam" / "skills").exists()
    assert not (main_agent / ".aiteam" / "workflows").exists()


def test_load_agent_capsule_keeps_own_and_shared_roots(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    agent_dir = tmp_path / "agents" / "main-agent"

    capsule = load_agent_capsule(agent_dir)

    assert capsule.agent_id == "main-agent"
    assert capsule.workspace_root == agent_dir.resolve()
    assert (tmp_path / "shared").resolve() in capsule.writable_roots
    assert (agent_dir / "work").resolve() in capsule.writable_roots


def test_team_file_tools_reject_another_agents_private_workspace(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    main_agent = tmp_path / "agents" / "main-agent"
    researcher = tmp_path / "agents" / "researcher"
    shutil.copytree(main_agent, researcher)
    manifest = researcher / ".aiteam" / "agent.yaml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace("id: main-agent", "id: researcher"), encoding="utf-8")
    shared_file = tmp_path / "shared" / "result.md"
    shared_file.write_text("published", encoding="utf-8")
    specs = {
        spec.name: spec.handler
        for spec in build_file_tool_specs(
            researcher,
            (researcher, tmp_path / "shared"),
            tmp_path / "shared",
        )
    }

    denied = specs["read_file"]("../main-agent/.aiteam/agent.yaml")
    allowed = specs["read_file"]("../../shared/result.md")
    aliased = specs["read_file"]("shared/result.md")
    globbed = specs["glob"]("*.md", path="shared")
    searched = specs["grep"]("published", path="shared")
    escaped = specs["read_file"]("shared/../main-agent/.aiteam/agent.yaml")

    assert "WorkspaceBoundary" in denied
    assert "published" in allowed
    assert "published" in aliased
    assert "result.md" in globbed
    assert "result.md" in searched
    assert "WorkspaceBoundary" in escaped


def test_discover_agent_requires_the_exact_agent_directory(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    agent_dir = tmp_path / "agents" / "main-agent"

    assert discover_agent(agent_dir).agent_id == "main-agent"
    assert discover_agent(tmp_path) is None
    assert discover_agent(tmp_path / "agents") is None
    assert discover_agent(tmp_path / "shared") is None
    assert discover_agent(agent_dir / "work") is None
    assert discover_agent(agent_dir / "outputs") is None
    assert discover_agent(agent_dir / ".aiteam") is None


def test_discover_agent_rejects_a_manifest_in_the_wrong_team_location(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    source = tmp_path / "agents" / "main-agent" / ".aiteam"
    scratch = tmp_path / "scratch"
    shutil.copytree(source, scratch / ".aiteam")

    with pytest.raises(ValueError, match="must be located directly"):
        discover_agent(scratch)


def test_discover_agent_rejects_a_mismatched_directory_id(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    manifest = tmp_path / "agents" / "main-agent" / ".aiteam" / "agent.yaml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace("id: main-agent", "id: other"), encoding="utf-8")

    with pytest.raises(ValueError, match="must match its directory name"):
        discover_agent(tmp_path / "agents" / "main-agent")


def test_direct_child_capsules_need_no_registration(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path)
    source = tmp_path / "agents" / "main-agent"
    researcher = tmp_path / "agents" / "researcher"
    shutil.copytree(source, researcher)
    manifest = researcher / ".aiteam" / "agent.yaml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8")
        .replace("id: main-agent", "id: researcher")
        .replace("name: Main Agent", "name: Researcher"),
        encoding="utf-8",
    )

    assert resolve_team_agent(project, "researcher").agent_id == "researcher"
    assert [agent.agent_id for agent in list_team_agents(project)] == ["main-agent", "researcher"]


def test_list_team_agents_excludes_invalid_directories(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path)
    ghost = tmp_path / "agents" / "ghost" / ".aiteam"
    ghost.mkdir(parents=True)
    (ghost / "agent.yaml").write_text("kind: Agent\nmetadata:\n  id: ghost\n", encoding="utf-8")

    assert [agent.agent_id for agent in list_team_agents(project)] == ["main-agent"]


def test_team_project_nesting_is_rejected_in_both_directions(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    (tmp_path / "nested").mkdir()
    with pytest.raises(ValueError, match="cannot be nested"):
        initialize_team_project(tmp_path / "nested")

    outer = tmp_path.parent / "outer"
    nested = outer / "deep" / "team"
    nested.mkdir(parents=True)
    initialize_team_project(nested)
    with pytest.raises(ValueError, match="cannot be nested"):
        initialize_team_project(outer)


def test_load_team_project_requires_its_main_agent_and_shared_root(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    shutil.rmtree(tmp_path / "shared")

    with pytest.raises(ValueError, match="shared_root"):
        load_team_project(tmp_path)


def test_materialize_team_agent_from_a_user_blueprint(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    project_root = tmp_path / "project"
    project_root.mkdir()
    project = initialize_team_project(project_root, project_id="quant-project")
    blueprint = tmp_path / "rind_home" / "blueprints" / "researcher"
    source = project_root / "agents" / "main-agent" / ".aiteam"
    shutil.copytree(source / "prompts", blueprint / "prompts")
    shutil.copy2(source / "agent.yaml", blueprint / "agent.yaml")

    capsule = materialize_team_agent(project, agent_id="researcher", blueprint="researcher")

    assert capsule.agent_id == "researcher"
    assert (project_root / "agents" / "researcher" / "work").is_dir()
    assert [agent.agent_id for agent in list_team_agents(project)] == ["main-agent", "researcher"]


def test_initialize_team_agent_creates_standard_structure(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path)
    capsule = initialize_team_agent(project, agent_id="weather-agent", description="Query weather data.")

    assert capsule.agent_id == "weather-agent"
    assert (capsule.workspace_root / ".aiteam" / "agent.yaml").is_file()
    assert (capsule.workspace_root / ".aiteam" / "prompts" / "system.md").read_text(encoding="utf-8").find("Query weather data") >= 0
    assert (capsule.workspace_root / "memory").is_dir()
    assert [agent.agent_id for agent in list_team_agents(project)] == ["main-agent", "weather-agent"]


def test_agent_create_tool_uses_semantic_description(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path)
    result = create_agent_create_tool_spec(project).handler("weather-agent", "Query weather data.")
    payload = json.loads(result)

    assert payload["ok"] is True
    assert payload["data"]["agent_id"] == "weather-agent"
    assert (tmp_path / "agents" / "weather-agent" / ".aiteam" / "agent.yaml").is_file()


def test_initialize_team_agents_only_handles_direct_bare_directories(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path)
    (project.agents_root / "weather-agent").mkdir()
    (project.agents_root / "plain").mkdir()
    result = initialize_team_agents(project)

    assert result["created"] == ["plain", "weather-agent"]
    assert result["skipped"] == ["main-agent"]
    assert len(list_team_agents(project)) == 3


def test_list_agent_blueprints_reads_valid_user_blueprints(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind-home"))
    blueprint = tmp_path / "rind-home" / "blueprints" / "weather"
    blueprint.mkdir(parents=True)
    (blueprint / "agent.yaml").write_text(
        "api_version: aiteam/v1\nkind: Agent\nmetadata:\n  id: weather\n  name: Weather\n  description: Weather reports\nspec: {}\n",
        encoding="utf-8",
    )

    assert list_agent_blueprints() == [{"id": "weather", "name": "Weather", "description": "Weather reports"}]


@pytest.mark.asyncio
async def test_workspace_lock_rejects_a_second_holder(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    first = WorkspaceLock("quant-project", "researcher")
    second = WorkspaceLock("quant-project", "researcher")

    async with first:
        with pytest.raises(WorkspaceBusyError, match="Workspace is busy: researcher"):
            await second.__aenter__()
    async with second:
        assert second.path.is_file()
