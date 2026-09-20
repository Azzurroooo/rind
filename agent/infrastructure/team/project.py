"""Team project discovery and member management."""

from __future__ import annotations

from pathlib import Path
import shutil
from typing import Any

from agent.infrastructure.paths import resolve_rind_home

from .manifests import (
    AGENT_MANIFEST,
    AITEAM_DIR,
    PROJECT_MANIFEST,
    agent_manifest,
    clean_text,
    manifest_paths,
    nested,
    project_manifest,
    read_yaml,
    require_mapping,
    resolve_manifest_path,
    text_list,
    validate_id,
    write_new_text,
    write_yaml,
)
from .models import AgentCapsule, ResolvedAgent, TeamProject


def initialize_team_project(
    project_root: str | Path,
    *,
    project_id: str | None = None,
    name: str | None = None,
    main_agent_id: str = "main-agent",
    main_agent_name: str = "Main Agent",
) -> TeamProject:
    root = Path(project_root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Project root does not exist: {root}")
    enclosing = _find_project_root(root.parent)
    if enclosing is not None:
        raise ValueError(f"Team projects cannot be nested: {enclosing} is already a Team project.")
    descendant = _find_descendant_project_root(root)
    if descendant is not None:
        raise ValueError(f"Team projects cannot be nested: {descendant} is already a Team project.")
    main_agent_id = validate_id(main_agent_id, "main_agent_id")
    project_id = validate_id(project_id or root.name, "project_id")
    project_name = clean_text(name or root.name, "name")

    team_dir = root / AITEAM_DIR
    main_workspace = root / "agents" / main_agent_id
    conflicts = [
        path
        for path in (
            team_dir / PROJECT_MANIFEST,
            main_workspace / AITEAM_DIR / AGENT_MANIFEST,
        )
        if path.exists()
    ]
    if conflicts:
        joined = ", ".join(str(path) for path in conflicts)
        raise ValueError(f"Team project already exists or conflicts with: {joined}")

    created: list[Path] = []
    try:
        _mkdir(team_dir, created)
        _mkdir(main_workspace / AITEAM_DIR / "prompts", created)
        for child in ("memory", "work", "outputs"):
            _mkdir(main_workspace / child, created)
        _mkdir(root / "shared", created)

        write_yaml(team_dir / PROJECT_MANIFEST, project_manifest(project_id, project_name, main_agent_id))
        write_yaml(main_workspace / AITEAM_DIR / AGENT_MANIFEST, agent_manifest(main_agent_id, main_agent_name))
        write_new_text(
            main_workspace / AITEAM_DIR / "prompts" / "system.md",
            "You are the main agent for this Team project. Coordinate specialized work with delegate, verify shared artifacts, and keep decisions concise.\n",
        )
    except Exception:
        _cleanup_created(created)
        raise
    return load_team_project(root)


def materialize_team_agent(project: TeamProject, *, agent_id: str, blueprint: str) -> AgentCapsule:
    """Copy one user Blueprint into a direct child Capsule without a roster entry."""
    clean_id = validate_id(agent_id, "agent_id")
    blueprint_id = validate_id(blueprint, "blueprint")
    blueprints_root = (resolve_rind_home() / "blueprints").resolve()
    blueprint_root = (blueprints_root / blueprint_id).resolve()
    if blueprint_root.parent != blueprints_root or not blueprint_root.is_dir():
        raise ValueError(f"Blueprint not found: {blueprint_id}")
    blueprint_manifest = blueprint_root / AGENT_MANIFEST
    manifest = require_mapping(read_yaml(blueprint_manifest), f"Invalid Blueprint manifest: {blueprint_manifest}")
    metadata = require_mapping(manifest.get("metadata"), "Blueprint metadata is required.")
    metadata["id"] = clean_id
    return _create_agent_capsule(project, clean_id, manifest, blueprint_root)


def initialize_team_agent(project: TeamProject, *, agent_id: str, description: str) -> AgentCapsule:
    clean_id = validate_id(agent_id, "agent_id")
    clean_description = clean_text(description, "description")
    name = clean_id.replace("-", " ").replace("_", " ").title()
    return _create_agent_capsule(project, clean_id, agent_manifest(clean_id, name, clean_description), allow_empty_target=True)


def initialize_team_agents(project: TeamProject) -> dict[str, list[str]]:
    created: list[str] = []
    skipped: list[str] = []
    for path in sorted(project.agents_root.iterdir(), key=lambda item: item.name.lower()):
        if not path.is_dir():
            continue
        agent_dir = path / AITEAM_DIR
        if agent_dir.exists():
            skipped.append(path.name)
            continue
        initialize_team_agent(project, agent_id=path.name, description=f"Agent for {path.name} tasks.")
        created.append(path.name)
    return {"created": created, "skipped": skipped}


def list_agent_blueprints() -> list[dict[str, str]]:
    root = (resolve_rind_home() / "blueprints").resolve()
    if not root.is_dir():
        return []
    result: list[dict[str, str]] = []
    for path in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not path.is_dir() or not (path / AGENT_MANIFEST).is_file():
            continue
        try:
            manifest = require_mapping(read_yaml(path / AGENT_MANIFEST), "Blueprint manifest is required.")
            metadata = require_mapping(manifest.get("metadata"), "Blueprint metadata is required.")
            blueprint_id = validate_id(path.name, "blueprint")
            result.append({
                "id": blueprint_id,
                "name": str(metadata.get("name") or blueprint_id).strip(),
                "description": str(metadata.get("description") or "").strip(),
            })
        except ValueError:
            continue
    return result


def _create_agent_capsule(
    project: TeamProject,
    agent_id: str,
    manifest: dict[str, Any],
    source_root: Path | None = None,
    allow_empty_target: bool = False,
) -> AgentCapsule:
    target = (project.agents_root / agent_id).resolve()
    if target.parent != project.agents_root:
        raise ValueError(f"Invalid Team Agent path: {agent_id}")
    if target.exists() and (not allow_empty_target or any(target.iterdir())):
        raise ValueError(f"Agent directory already exists: {target}")
    target_created = not target.exists()
    created: list[Path] = []
    try:
        _mkdir(target / AITEAM_DIR, created)
        write_yaml(target / AITEAM_DIR / AGENT_MANIFEST, manifest)
        if source_root is None:
            _mkdir(target / AITEAM_DIR / "prompts", created)
            description = str(manifest.get("metadata", {}).get("description") or "").strip()
            write_new_text(
                target / AITEAM_DIR / "prompts" / "system.md",
                f"You are the {agent_id} Agent in a Team project. Your responsibility is: {description}.\n",
            )
        else:
            for name in ("prompts", "skills", "workflows"):
                source = source_root / name
                if source.exists():
                    if not source.is_dir():
                        raise ValueError(f"Blueprint resource is not a directory: {source}")
                    shutil.copytree(source, target / AITEAM_DIR / name)
        for name in ("memory", "work", "outputs"):
            _mkdir(target / name, created)
        return resolve_team_agent(project, agent_id)
    except Exception:
        _cleanup_created(created)
        if target_created and target.exists():
            shutil.rmtree(target, ignore_errors=True)
        raise


def load_agent_capsule(workspace_root: str | Path) -> AgentCapsule:
    workspace = Path(workspace_root).expanduser().resolve()
    manifest_path = workspace / AITEAM_DIR / AGENT_MANIFEST
    manifest = require_mapping(read_yaml(manifest_path), f"Invalid agent manifest: {manifest_path}")
    if manifest.get("kind") != "Agent":
        raise ValueError(f"Unsupported agent manifest kind: {manifest.get('kind')}")

    metadata = require_mapping(manifest.get("metadata"), "Agent metadata is required.")
    spec = require_mapping(manifest.get("spec"), "Agent spec is required.")
    agent_id = validate_id(metadata.get("id"), "metadata.id")
    name = clean_text(metadata.get("name") or agent_id, "metadata.name")
    description = str(metadata.get("description") or "")
    prompt_paths = manifest_paths(spec, ("prompts", "system"), manifest_path.parent)
    prompt = "\n\n".join(path.read_text(encoding="utf-8").strip() for path in prompt_paths if path.is_file()).strip()
    skills = tuple(text_list(nested(spec, "skills", "enabled")))
    workflows = tuple(text_list(nested(spec, "workflows", "available")))
    writable = tuple(manifest_paths(spec, ("filesystem", "writable"), manifest_path.parent, require_files=False))
    readonly = tuple(manifest_paths(spec, ("filesystem", "readonly"), manifest_path.parent, require_files=False))
    return AgentCapsule(
        agent_id=agent_id,
        name=name,
        description=description,
        workspace_root=workspace,
        manifest_path=manifest_path,
        system_prompt=prompt,
        enabled_skills=skills,
        available_workflows=workflows,
        writable_roots=writable,
        readonly_roots=readonly,
    )


def load_team_project(project_root: str | Path) -> TeamProject:
    root = Path(project_root).expanduser().resolve()
    project_path = root / AITEAM_DIR / PROJECT_MANIFEST
    project_manifest = require_mapping(read_yaml(project_path), f"Invalid project manifest: {project_path}")
    if project_manifest.get("kind") != "Project":
        raise ValueError(f"Unsupported project manifest kind: {project_manifest.get('kind')}")
    metadata = require_mapping(project_manifest.get("metadata"), "Project metadata is required.")
    spec = require_mapping(project_manifest.get("spec"), "Project spec is required.")
    project_id = validate_id(metadata.get("id"), "metadata.id")
    name = clean_text(metadata.get("name") or project_id, "metadata.name")
    main_agent = validate_id(spec.get("main_agent"), "main_agent")
    agents_root = resolve_manifest_path(root / AITEAM_DIR, spec.get("agents_root") or "../agents")
    shared_root = resolve_manifest_path(root / AITEAM_DIR, spec.get("shared_root") or "../shared")
    if not agents_root.is_relative_to(root) or not shared_root.is_relative_to(root):
        raise ValueError("Team paths must stay inside the project root.")
    if not agents_root.is_dir() or not shared_root.is_dir():
        raise ValueError("Team agents_root and shared_root must exist.")
    project = TeamProject(
        project_id=project_id,
        name=name,
        project_root=root,
        main_agent=main_agent,
        agents_root=agents_root,
        shared_root=shared_root,
    )
    resolve_team_agent(project, main_agent)
    return project


def discover_agent(cwd: str | Path | None = None) -> ResolvedAgent | None:
    """Resolve the manifest-bearing agent that owns this exact directory."""
    start = Path(cwd or Path.cwd()).expanduser().resolve()
    if not (start / AITEAM_DIR / AGENT_MANIFEST).is_file():
        return None
    capsule = load_agent_capsule(start)
    team_root = _find_project_root(start)
    if team_root is None:
        return ResolvedAgent(capsule, None)
    project = load_team_project(team_root)
    _validate_team_agent_capsule(capsule, project)
    return ResolvedAgent(capsule, project)


def resolve_team_agent(project: TeamProject, agent_id: str) -> AgentCapsule:
    """Load one valid direct child Capsule without using a Team roster."""
    clean_id = validate_id(agent_id, "agent_id")
    workspace_root = (project.agents_root / clean_id).resolve()
    if workspace_root.parent != project.agents_root:
        raise ValueError(f"Invalid Team Agent path: {clean_id}")
    capsule = load_agent_capsule(workspace_root)
    _validate_team_agent_capsule(capsule, project)
    return capsule


def list_team_agents(project: TeamProject) -> tuple[AgentCapsule, ...]:
    """Return valid direct child Capsules in stable id order."""
    if not project.agents_root.is_dir():
        return ()
    capsules: list[AgentCapsule] = []
    for path in project.agents_root.iterdir():
        if not path.is_dir() or not (path / AITEAM_DIR / AGENT_MANIFEST).is_file():
            continue
        try:
            capsule = load_agent_capsule(path)
            _validate_team_agent_capsule(capsule, project)
        except ValueError:
            continue
        capsules.append(capsule)
    return tuple(sorted(capsules, key=lambda capsule: capsule.agent_id))


def render_team_agent_catalog(project: TeamProject) -> str:
    """Render the main Agent's transient, filesystem-derived delegate catalog."""
    agents = [capsule for capsule in list_team_agents(project) if capsule.agent_id != project.main_agent]
    if not agents:
        return ""
    lines = ["<available_team_agents>"]
    for capsule in agents:
        description = capsule.description.strip() or "No description provided."
        lines.append(f"- {capsule.agent_id} | {capsule.name} | {description}")
    lines.append("</available_team_agents>")
    return "\n".join(lines)


def _find_project_root(start: Path) -> Path | None:
    for path in (start, *start.parents):
        if (path / AITEAM_DIR / PROJECT_MANIFEST).is_file():
            return path
    return None


def _find_descendant_project_root(root: Path) -> Path | None:
    for manifest in root.glob(f"**/{AITEAM_DIR}/{PROJECT_MANIFEST}"):
        project_root = manifest.parent.parent.resolve()
        if project_root != root:
            return project_root
    return None


def _validate_team_agent_capsule(capsule: AgentCapsule, project: TeamProject) -> None:
    expected_parent = project.agents_root
    if capsule.workspace_root.parent != expected_parent:
        raise ValueError(f"Team agent must be located directly in {expected_parent}: {capsule.workspace_root}")
    if capsule.agent_id != capsule.workspace_root.name:
        raise ValueError(
            f"Team agent id must match its directory name: {capsule.agent_id} != {capsule.workspace_root.name}"
        )


def _mkdir(path: Path, created: list[Path]) -> None:
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True)
    if not existed:
        created.append(path)


def _cleanup_created(paths: list[Path]) -> None:
    for path in sorted(paths, key=lambda item: len(item.parts), reverse=True):
        try:
            if path.exists():
                shutil.rmtree(path)
        except OSError:
            pass
