from pathlib import Path
import sqlite3
import sys

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.team import discover_agent, initialize_team_project, load_agent_capsule, load_team_project


def test_initialize_team_project_creates_main_agent_capsule(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path, project_id="quant-project", name="Quant Project")

    main_workspace = tmp_path / "agents" / "main-agent" / "workspace"
    assert project.project_id == "quant-project"
    assert project.default_agent == "main-agent"
    assert project.agents["main-agent"] == main_workspace.resolve()
    assert (tmp_path / ".aiteam" / "project.yaml").is_file()
    assert (tmp_path / ".aiteam" / "organization.yaml").is_file()
    assert (tmp_path / ".aiteam" / "state.db").is_file()
    assert (main_workspace / ".aiteam" / "agent.yaml").is_file()
    assert (main_workspace / ".aiteam" / "origin.lock.yaml").is_file()
    assert (main_workspace / "memory").is_dir()
    assert (main_workspace / "work").is_dir()
    assert (main_workspace / "outputs").is_dir()
    assert (tmp_path / "shared" / "artifacts").is_dir()

    with sqlite3.connect(tmp_path / ".aiteam" / "state.db") as db:
        rows = dict(db.execute("SELECT key, value FROM state_meta").fetchall())
    assert rows["project_id"] == "quant-project"
    assert rows["default_agent"] == "main-agent"


def test_load_agent_capsule_reads_manifest_prompt_and_workspace_paths(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    workspace = tmp_path / "agents" / "main-agent" / "workspace"

    capsule = load_agent_capsule(workspace)

    assert capsule.agent_id == "main-agent"
    assert capsule.workspace_root == workspace.resolve()
    assert "main agent" in capsule.system_prompt.lower()
    assert capsule.writable_roots == (
        (workspace / "work").resolve(),
        (workspace / "outputs").resolve(),
        (workspace / "memory").resolve(),
    )
    assert capsule.readonly_roots == ((workspace / ".aiteam").resolve(),)


def test_discover_agent_only_uses_current_workspace_or_children(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    workspace = tmp_path / "agents" / "main-agent" / "workspace"

    assert discover_agent(tmp_path) is None
    assert discover_agent(tmp_path / "agents") is None
    assert discover_agent(workspace.parent) is None
    assert discover_agent(workspace).agent_id == "main-agent"
    assert discover_agent(workspace / "work").workspace_root == workspace.resolve()


def test_team_project_rejects_organization_workspace_escape(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    organization = tmp_path / ".aiteam" / "organization.yaml"
    organization.write_text(
        "default_agent: main-agent\n"
        "agents:\n"
        "  main-agent:\n"
        "    workspace: ../outside\n"
        "    organization_role: root\n"
        "    status: active\n"
        "relations: []\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="escapes project root"):
        load_team_project(tmp_path)


def test_initialize_team_project_refuses_existing_team_files(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)

    with pytest.raises(ValueError, match="already exists"):
        initialize_team_project(tmp_path)
