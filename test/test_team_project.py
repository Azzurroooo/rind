from pathlib import Path
import re
import shutil
import sys

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.team import discover_agent, initialize_team_project, load_agent_capsule, load_team_project


def test_initialize_team_project_creates_main_agent_capsule(tmp_path: Path) -> None:
    project = initialize_team_project(tmp_path, project_id="quant-project", name="Quant Project")

    main_workspace = tmp_path / "agents" / "main-agent"
    assert project.project_id == "quant-project"
    assert project.default_agent == "main-agent"
    assert project.agents["main-agent"] == main_workspace.resolve()
    assert (tmp_path / ".aiteam" / "project.yaml").is_file()
    assert (tmp_path / ".aiteam" / "organization.yaml").is_file()
    assert (main_workspace / ".aiteam" / "agent.yaml").is_file()
    assert (main_workspace / ".aiteam" / "origin.lock.yaml").is_file()
    assert (main_workspace / "memory").is_dir()
    assert (main_workspace / "work").is_dir()
    assert (main_workspace / "outputs").is_dir()
    assert (tmp_path / "shared" / "artifacts").is_dir()

    assert not (tmp_path / ".aiteam" / "state.db").exists()
    assert "state_backend" not in (tmp_path / ".aiteam" / "project.yaml").read_text(encoding="utf-8")


def test_load_agent_capsule_reads_manifest_prompt_and_workspace_paths(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    workspace = tmp_path / "agents" / "main-agent"

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


def test_discover_agent_requires_the_exact_agent_directory(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    agent_dir = tmp_path / "agents" / "main-agent"

    # Agents and directories are one to one. Running in agents/<id> is what
    # makes a session that agent; every other path is a plain Rind session.
    assert discover_agent(agent_dir).agent_id == "main-agent"
    assert discover_agent(agent_dir).workspace_root == agent_dir.resolve()
    assert discover_agent(tmp_path) is None
    assert discover_agent(tmp_path / "agents") is None
    assert discover_agent(tmp_path / "shared") is None
    assert discover_agent(tmp_path / "agents" / "ghost") is None
    assert discover_agent(agent_dir / "work") is None
    assert discover_agent(agent_dir / ".aiteam") is None
    assert discover_agent(agent_dir / ".aiteam" / "prompts") is None


def test_team_project_cannot_be_created_inside_another_team_project(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)

    for nested in (
        tmp_path / "agents",
        tmp_path / "agents" / "main-agent",
        tmp_path / "agents" / "main-agent" / "work",
        tmp_path / "shared" / "artifacts",
    ):
        with pytest.raises(ValueError, match="cannot be nested"):
            initialize_team_project(nested)


def test_team_project_cannot_contain_another_team_project(tmp_path: Path) -> None:
    nested = tmp_path / "deep" / "inside" / "team"
    nested.mkdir(parents=True)
    initialize_team_project(nested)

    with pytest.raises(ValueError, match=re.escape(str(nested.resolve()))):
        initialize_team_project(tmp_path)


def test_discover_agent_rejects_team_capsule_outside_agents_root(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    source = tmp_path / "agents" / "main-agent" / ".aiteam"
    scratch = tmp_path / "scratch"
    shutil.copytree(source, scratch / ".aiteam")

    with pytest.raises(ValueError, match="must be located directly"):
        discover_agent(scratch)


def test_discover_agent_rejects_team_capsule_with_mismatched_directory_id(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    agent_dir = tmp_path / "agents" / "main-agent"
    manifest = agent_dir / ".aiteam" / "agent.yaml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8").replace("id: main-agent", "id: other-agent"),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="must match its directory name"):
        discover_agent(agent_dir)


def test_discover_agent_does_not_require_organization_registration(tmp_path: Path) -> None:
    initialize_team_project(tmp_path)
    source = tmp_path / "agents" / "main-agent" / ".aiteam"
    agent_dir = tmp_path / "agents" / "researcher"
    shutil.copytree(source, agent_dir / ".aiteam")
    manifest = agent_dir / ".aiteam" / "agent.yaml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8").replace("id: main-agent", "id: researcher"),
        encoding="utf-8",
    )

    resolved = discover_agent(agent_dir)

    assert resolved.agent_id == "researcher"
    assert resolved.project_id == tmp_path.name


@pytest.mark.parametrize("missing_name", ("project.yaml", "organization.yaml"))
def test_discover_agent_rejects_incomplete_team_project(tmp_path: Path, missing_name: str) -> None:
    initialize_team_project(tmp_path)
    (tmp_path / ".aiteam" / missing_name).unlink()

    with pytest.raises(ValueError, match="Incomplete Team project"):
        discover_agent(tmp_path / "agents" / "main-agent")


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


def test_initialize_team_project_rejects_existing_user_runtime_namespace(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "rind_home"))
    (tmp_path / "rind_home" / "teams" / "quant-project").mkdir(parents=True)

    with pytest.raises(ValueError, match="runtime state already exists"):
        initialize_team_project(tmp_path, project_id="quant-project")
