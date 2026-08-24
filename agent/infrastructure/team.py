"""Filesystem model for .aiteam projects and agent capsules."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.infrastructure.paths import resolve_rind_home

AITEAM_DIR = ".aiteam"
AGENT_MANIFEST = "agent.yaml"
PROJECT_MANIFEST = "project.yaml"


@dataclass(frozen=True, slots=True)
class AgentCapsule:
    agent_id: str
    name: str
    description: str
    workspace_root: Path
    manifest_path: Path
    system_prompt: str
    enabled_skills: tuple[str, ...]
    available_workflows: tuple[str, ...]
    writable_roots: tuple[Path, ...]
    readonly_roots: tuple[Path, ...]


@dataclass(frozen=True, slots=True)
class TeamProject:
    project_id: str
    name: str
    project_root: Path
    main_agent: str
    agents_root: Path
    shared_root: Path


@dataclass(frozen=True, slots=True)
class ResolvedAgent:
    capsule: AgentCapsule
    project: TeamProject | None

    @property
    def workspace_root(self) -> Path:
        return self.capsule.workspace_root

    @property
    def project_id(self) -> str | None:
        return self.project.project_id if self.project else None

    @property
    def agent_id(self) -> str:
        return self.capsule.agent_id


class WorkspaceBusyError(RuntimeError):
    """Raised when a Team Agent workspace is already serving another turn."""


class WorkspaceLock:
    """A non-blocking, cross-process lock for one Team Agent workspace."""

    def __init__(self, project_id: str, agent_id: str) -> None:
        self._agent_id = _clean_id(agent_id, "agent_id")
        self._path = resolve_rind_home() / "locks" / _clean_id(project_id, "project_id") / f"{self._agent_id}.lock"
        self._handle = None

    @property
    def path(self) -> Path:
        return self._path

    async def __aenter__(self) -> WorkspaceLock:
        self.acquire()
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        self.release()

    def acquire(self) -> None:
        if self._handle is not None:
            raise RuntimeError(f"Workspace lock is already held: {self._agent_id}")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = self._path.open("a+b")
        try:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise WorkspaceBusyError(f"Workspace is busy: {self._agent_id}") from exc
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


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
    main_agent_id = _clean_id(main_agent_id, "main_agent_id")
    project_id = _clean_id(project_id or root.name, "project_id")
    project_name = _clean_text(name or root.name, "name")

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

        _write_yaml(team_dir / PROJECT_MANIFEST, _project_manifest(project_id, project_name, main_agent_id))
        _write_yaml(main_workspace / AITEAM_DIR / AGENT_MANIFEST, _agent_manifest(main_agent_id, main_agent_name))
        _write_text(
            main_workspace / AITEAM_DIR / "prompts" / "system.md",
            "You are the main agent for this Team project. Coordinate specialized work with delegate, verify shared artifacts, and keep decisions concise.\n",
        )
    except Exception:
        _cleanup_created(created)
        raise
    return load_team_project(root)


def materialize_team_agent(project: TeamProject, *, agent_id: str, blueprint: str) -> AgentCapsule:
    """Copy one user Blueprint into a direct child Capsule without a roster entry."""
    clean_id = _clean_id(agent_id, "agent_id")
    blueprint_id = _clean_id(blueprint, "blueprint")
    blueprints_root = (resolve_rind_home() / "blueprints").resolve()
    blueprint_root = (blueprints_root / blueprint_id).resolve()
    if blueprint_root.parent != blueprints_root or not blueprint_root.is_dir():
        raise ValueError(f"Blueprint not found: {blueprint_id}")
    blueprint_manifest = blueprint_root / AGENT_MANIFEST
    manifest = _require_mapping(_read_yaml(blueprint_manifest), f"Invalid Blueprint manifest: {blueprint_manifest}")
    metadata = _require_mapping(manifest.get("metadata"), "Blueprint metadata is required.")
    metadata["id"] = clean_id
    return _create_agent_capsule(project, clean_id, manifest, blueprint_root)


def initialize_team_agent(project: TeamProject, *, agent_id: str, description: str) -> AgentCapsule:
    clean_id = _clean_id(agent_id, "agent_id")
    clean_description = _clean_text(description, "description")
    name = clean_id.replace("-", " ").replace("_", " ").title()
    return _create_agent_capsule(project, clean_id, _agent_manifest(clean_id, name, clean_description), allow_empty_target=True)


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
            manifest = _require_mapping(_read_yaml(path / AGENT_MANIFEST), "Blueprint manifest is required.")
            metadata = _require_mapping(manifest.get("metadata"), "Blueprint metadata is required.")
            blueprint_id = _clean_id(path.name, "blueprint")
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
        _write_yaml(target / AITEAM_DIR / AGENT_MANIFEST, manifest)
        if source_root is None:
            _mkdir(target / AITEAM_DIR / "prompts", created)
            description = str(manifest.get("metadata", {}).get("description") or "").strip()
            _write_text(
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
    manifest = _require_mapping(_read_yaml(manifest_path), f"Invalid agent manifest: {manifest_path}")
    if manifest.get("kind") != "Agent":
        raise ValueError(f"Unsupported agent manifest kind: {manifest.get('kind')}")

    metadata = _require_mapping(manifest.get("metadata"), "Agent metadata is required.")
    spec = _require_mapping(manifest.get("spec"), "Agent spec is required.")
    agent_id = _clean_id(metadata.get("id"), "metadata.id")
    name = _clean_text(metadata.get("name") or agent_id, "metadata.name")
    description = str(metadata.get("description") or "")
    prompt_paths = _manifest_paths(spec, ("prompts", "system"), manifest_path.parent)
    prompt = "\n\n".join(path.read_text(encoding="utf-8").strip() for path in prompt_paths if path.is_file()).strip()
    skills = tuple(_text_list(_nested(spec, "skills", "enabled")))
    workflows = tuple(_text_list(_nested(spec, "workflows", "available")))
    writable = tuple(_manifest_paths(spec, ("filesystem", "writable"), manifest_path.parent, require_files=False))
    readonly = tuple(_manifest_paths(spec, ("filesystem", "readonly"), manifest_path.parent, require_files=False))
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
    project_manifest = _require_mapping(_read_yaml(project_path), f"Invalid project manifest: {project_path}")
    if project_manifest.get("kind") != "Project":
        raise ValueError(f"Unsupported project manifest kind: {project_manifest.get('kind')}")
    metadata = _require_mapping(project_manifest.get("metadata"), "Project metadata is required.")
    spec = _require_mapping(project_manifest.get("spec"), "Project spec is required.")
    project_id = _clean_id(metadata.get("id"), "metadata.id")
    name = _clean_text(metadata.get("name") or project_id, "metadata.name")
    main_agent = _clean_id(spec.get("main_agent"), "main_agent")
    agents_root = _resolve_manifest_path(root / AITEAM_DIR, spec.get("agents_root") or "../agents")
    shared_root = _resolve_manifest_path(root / AITEAM_DIR, spec.get("shared_root") or "../shared")
    if not _is_relative_to(agents_root, root) or not _is_relative_to(shared_root, root):
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
    team_root = _find_team_root(start)
    if team_root is None:
        return ResolvedAgent(capsule, None)
    project = load_team_project(team_root)
    _validate_team_agent_capsule(capsule, project)
    return ResolvedAgent(capsule, project)


def resolve_team_agent(project: TeamProject, agent_id: str) -> AgentCapsule:
    """Load one valid direct child Capsule without using a Team roster."""
    clean_id = _clean_id(agent_id, "agent_id")
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


def _project_manifest(project_id: str, name: str, main_agent_id: str) -> dict[str, Any]:
    return {
        "api_version": "aiteam/v1",
        "kind": "Project",
        "metadata": {"id": project_id, "name": name},
        "spec": {
            "main_agent": main_agent_id,
            "shared_root": "../shared",
            "agents_root": "../agents",
        },
    }


def _agent_manifest(agent_id: str, name: str, description: str = "Default Team entry agent.") -> dict[str, Any]:
    return {
        "api_version": "aiteam/v1",
        "kind": "Agent",
        "metadata": {
            "id": agent_id,
            "name": name,
            "description": description,
        },
        "spec": {
            "prompts": {"system": ["./prompts/system.md"]},
            "skills": {"enabled": []},
            "workflows": {"available": []},
            "memory": {"root": "../memory", "scope": "agent_project"},
            "filesystem": {
                "writable": ["../work", "../outputs", "../memory", "../../../shared"],
                "readonly": ["..", "../../../shared"],
            },
        },
    }


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


def _find_team_root(start: Path) -> Path | None:
    for path in (start, *start.parents):
        if (path / AITEAM_DIR / PROJECT_MANIFEST).is_file():
            return path
    return None


def _validate_team_agent_capsule(capsule: AgentCapsule, project: TeamProject) -> None:
    expected_parent = project.agents_root
    if capsule.workspace_root.parent != expected_parent:
        raise ValueError(f"Team agent must be located directly in {expected_parent}: {capsule.workspace_root}")
    if capsule.agent_id != capsule.workspace_root.name:
        raise ValueError(
            f"Team agent id must match its directory name: {capsule.agent_id} != {capsule.workspace_root.name}"
        )


def _manifest_paths(spec: dict[str, Any], path: tuple[str, ...], base: Path, *, require_files: bool = True) -> list[Path]:
    paths = [_resolve_manifest_path(base, item) for item in _text_list(_nested(spec, *path))]
    if require_files:
        missing = [path for path in paths if not path.is_file()]
        if missing:
            raise ValueError(f"Manifest references missing file: {missing[0]}")
    return paths


def _nested(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _resolve_manifest_path(base: Path, value: object) -> Path:
    raw = _clean_text(value, "path")
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.resolve()


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    _write_text(path, _dump_yaml(data))


def _read_yaml(path: Path) -> Any:
    if not path.is_file():
        raise ValueError(f"Missing file: {path}")
    text = path.read_text(encoding="utf-8")
    stripped = text.strip()
    if not stripped:
        return {}
    if stripped.startswith("{"):
        return json.loads(stripped)
    lines = _yaml_lines(text)
    if not lines:
        return {}
    value, index = _parse_yaml_block(lines, 0, lines[0][0])
    if index != len(lines):
        raise ValueError(f"Unsupported YAML structure: {path}")
    return value


def _yaml_lines(text: str) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append((indent, raw.strip()))
    return lines


def _parse_yaml_block(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[Any, int]:
    if lines[index][1].startswith("- "):
        return _parse_yaml_list(lines, index, indent)
    return _parse_yaml_map(lines, index, indent)


def _parse_yaml_list(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[list[Any], int]:
    result: list[Any] = []
    while index < len(lines) and lines[index][0] == indent and lines[index][1].startswith("- "):
        item = lines[index][1][2:].strip()
        index += 1
        if not item:
            value, index = _parse_yaml_block(lines, index, indent + 2)
            result.append(value)
            continue
        if ":" in item and not item.startswith(('"', "'")):
            key, value = _split_yaml_pair(item)
            mapping = {key: _parse_scalar(value)}
            while index < len(lines) and lines[index][0] == indent + 2 and not lines[index][1].startswith("- "):
                child_key, child_value = _split_yaml_pair(lines[index][1])
                index += 1
                if child_value == "" and index < len(lines) and lines[index][0] > indent + 2:
                    parsed, index = _parse_yaml_block(lines, index, lines[index][0])
                    mapping[child_key] = parsed
                else:
                    mapping[child_key] = _parse_scalar(child_value)
            result.append(mapping)
            continue
        result.append(_parse_scalar(item))
    return result, index


def _parse_yaml_map(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    while index < len(lines) and lines[index][0] == indent and not lines[index][1].startswith("- "):
        key, value = _split_yaml_pair(lines[index][1])
        index += 1
        if value == "" and index < len(lines) and lines[index][0] > indent:
            parsed, index = _parse_yaml_block(lines, index, lines[index][0])
            result[key] = parsed
        else:
            result[key] = _parse_scalar(value)
    return result, index


def _split_yaml_pair(text: str) -> tuple[str, str]:
    if ":" not in text:
        raise ValueError(f"Invalid YAML line: {text}")
    key, value = text.split(":", 1)
    key = key.strip()
    if not key:
        raise ValueError(f"Invalid YAML key: {text}")
    return key, value.strip()


def _parse_scalar(value: str) -> Any:
    if value == "":
        return ""
    if value == "[]":
        return []
    if value == "{}":
        return {}
    if value in {"null", "~"}:
        return None
    if value in {"true", "false"}:
        return value == "true"
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def _dump_yaml(data: Any, indent: int = 0) -> str:
    lines = _dump_yaml_lines(data, indent)
    return "\n".join(lines) + "\n"


def _dump_yaml_lines(data: Any, indent: int) -> list[str]:
    prefix = " " * indent
    if isinstance(data, dict):
        lines: list[str] = []
        for key, value in data.items():
            if isinstance(value, (dict, list)) and value:
                lines.append(f"{prefix}{key}:")
                lines.extend(_dump_yaml_lines(value, indent + 2))
            else:
                lines.append(f"{prefix}{key}: {_format_scalar(value)}")
        return lines
    if isinstance(data, list):
        if not data:
            return [f"{prefix}[]"]
        lines = []
        for item in data:
            if isinstance(item, dict):
                if not item:
                    lines.append(f"{prefix}- {{}}")
                    continue
                first = True
                for key, value in item.items():
                    marker = "- " if first else "  "
                    if isinstance(value, (dict, list)) and value:
                        lines.append(f"{prefix}{marker}{key}:")
                        lines.extend(_dump_yaml_lines(value, indent + 4))
                    else:
                        lines.append(f"{prefix}{marker}{key}: {_format_scalar(value)}")
                    first = False
            elif isinstance(item, list):
                lines.append(f"{prefix}-")
                lines.extend(_dump_yaml_lines(item, indent + 2))
            else:
                lines.append(f"{prefix}- {_format_scalar(item)}")
        return lines
    return [f"{prefix}{_format_scalar(data)}"]


def _format_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value == []:
        return "[]"
    if value == {}:
        return "{}"
    text = str(value)
    if text == "" or text.strip() != text or any(char in text for char in ("#", "\n")):
        return json.dumps(text, ensure_ascii=False)
    return text


def _clean_id(value: object, field: str) -> str:
    text = _clean_text(value, field)
    if any(char in text for char in ("/", "\\", ":")) or text in {".", ".."}:
        raise ValueError(f"Invalid {field}: {text}")
    return text


def _clean_text(value: object, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required.")
    return text


def _text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Expected a list.")
    return [_clean_text(item, "list item") for item in value]


def _require_mapping(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(message)
    return value


def _mkdir(path: Path, created: list[Path]) -> None:
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True)
    if not existed:
        created.append(path)


def _write_text(path: Path, text: str) -> None:
    if path.exists():
        raise ValueError(f"Refusing to overwrite existing file: {path}")
    path.write_text(text, encoding="utf-8")


def _cleanup_created(paths: list[Path]) -> None:
    for path in sorted(paths, key=lambda item: len(item.parts), reverse=True):
        try:
            if path.exists():
                shutil.rmtree(path)
        except OSError:
            pass


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
