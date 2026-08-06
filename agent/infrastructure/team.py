"""Filesystem model for .aiteam projects and agent capsules."""

from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


AITEAM_DIR = ".aiteam"
AGENT_MANIFEST = "agent.yaml"
PROJECT_MANIFEST = "project.yaml"
ORGANIZATION_MANIFEST = "organization.yaml"
STATE_DB = "state.db"


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
    default_agent: str
    agents_root: Path
    shared_root: Path
    state_backend: Path
    agents: dict[str, Path]


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
    main_agent_id = _clean_id(main_agent_id, "main_agent_id")
    project_id = _clean_id(project_id or root.name, "project_id")
    project_name = _clean_text(name or root.name, "name")

    team_dir = root / AITEAM_DIR
    main_workspace = root / "agents" / main_agent_id
    conflicts = [
        path
        for path in (
            team_dir / PROJECT_MANIFEST,
            team_dir / ORGANIZATION_MANIFEST,
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
        _mkdir(main_workspace / AITEAM_DIR / "skills", created)
        _mkdir(main_workspace / AITEAM_DIR / "workflows", created)
        for child in ("memory", "work", "outputs"):
            _mkdir(main_workspace / child, created)
        for child in ("datasets", "artifacts", "reports", "decisions"):
            _mkdir(root / "shared" / child, created)

        _write_yaml(team_dir / PROJECT_MANIFEST, _project_manifest(project_id, project_name, main_agent_id))
        _write_yaml(team_dir / ORGANIZATION_MANIFEST, _organization_manifest(main_agent_id))
        _write_yaml(main_workspace / AITEAM_DIR / AGENT_MANIFEST, _agent_manifest(main_agent_id, main_agent_name))
        _write_yaml(
            main_workspace / AITEAM_DIR / "origin.lock.yaml",
            {
                "source": "team_create",
                "materialized_at": datetime.now(timezone.utc).isoformat(),
                "mode": "generated",
            },
        )
        _write_text(main_workspace / AITEAM_DIR / "prompts" / "system.md", "You are the main agent for this Team project.\n")
        _write_text(main_workspace / AITEAM_DIR / "prompts" / "role.md", "Coordinate work, keep boundaries clear, and publish stable outputs to shared artifacts.\n")
        _write_text(main_workspace / AITEAM_DIR / "prompts" / "methodology.md", "Prefer small verifiable steps, explicit messages, and concise artifacts.\n")
        _init_state_db(team_dir / STATE_DB, project_id=project_id, default_agent=main_agent_id)
    except Exception:
        _cleanup_created(created)
        raise
    return load_team_project(root)


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
    organization_path = root / AITEAM_DIR / ORGANIZATION_MANIFEST
    project_manifest = _require_mapping(_read_yaml(project_path), f"Invalid project manifest: {project_path}")
    organization = _require_mapping(_read_yaml(organization_path), f"Invalid organization manifest: {organization_path}")
    if project_manifest.get("kind") != "Project":
        raise ValueError(f"Unsupported project manifest kind: {project_manifest.get('kind')}")
    metadata = _require_mapping(project_manifest.get("metadata"), "Project metadata is required.")
    spec = _require_mapping(project_manifest.get("spec"), "Project spec is required.")
    project_id = _clean_id(metadata.get("id"), "metadata.id")
    name = _clean_text(metadata.get("name") or project_id, "metadata.name")
    default_agent = _clean_id(spec.get("default_agent") or organization.get("default_agent"), "default_agent")
    agents_root = _resolve_manifest_path(root / AITEAM_DIR, spec.get("agents_root") or "../agents")
    shared_root = _resolve_manifest_path(root / AITEAM_DIR, spec.get("shared_root") or "../shared")
    state_backend = _resolve_manifest_path(root / AITEAM_DIR, spec.get("state_backend") or "./state.db")
    agents = _organization_agents(root, organization)
    if default_agent not in agents:
        raise ValueError(f"Default agent is not registered: {default_agent}")
    return TeamProject(
        project_id=project_id,
        name=name,
        project_root=root,
        default_agent=default_agent,
        agents_root=agents_root,
        shared_root=shared_root,
        state_backend=state_backend,
        agents=agents,
    )


def discover_agent(cwd: str | Path | None = None) -> ResolvedAgent | None:
    """Resolve the agent that owns this exact directory.

    An agent is its directory: running inside `agents/<id>/` is what makes a
    session that agent. Nothing else resolves -- not the project root, not a
    subdirectory of the agent. Those are ordinary Rind sessions.
    """
    start = Path(cwd or Path.cwd()).expanduser().resolve()
    if not (start / AITEAM_DIR / AGENT_MANIFEST).is_file():
        return None
    return ResolvedAgent(load_agent_capsule(start), find_team_project(start))


def find_team_project(cwd: str | Path | None = None) -> TeamProject | None:
    root = _find_project_root(Path(cwd or Path.cwd()).expanduser().resolve())
    return load_team_project(root) if root is not None else None


def _project_manifest(project_id: str, name: str, main_agent_id: str) -> dict[str, Any]:
    return {
        "api_version": "aiteam/v1",
        "kind": "Project",
        "metadata": {"id": project_id, "name": name},
        "spec": {
            "mode": "team",
            "default_agent": main_agent_id,
            "shared_root": "../shared",
            "agents_root": "../agents",
            "state_backend": "./state.db",
        },
    }


def _organization_manifest(main_agent_id: str) -> dict[str, Any]:
    return {
        "default_agent": main_agent_id,
        "agents": {
            main_agent_id: {
                "workspace": f"agents/{main_agent_id}",
                "organization_role": "root",
                "status": "active",
            }
        },
        "relations": [],
    }


def _agent_manifest(agent_id: str, name: str) -> dict[str, Any]:
    return {
        "api_version": "aiteam/v1",
        "kind": "Agent",
        "metadata": {
            "id": agent_id,
            "name": name,
            "description": "Default Team entry agent.",
        },
        "spec": {
            "prompts": {"system": ["./prompts/system.md", "./prompts/role.md", "./prompts/methodology.md"]},
            "skills": {"search_paths": ["./skills"], "enabled": []},
            "workflows": {"search_paths": ["./workflows"], "available": []},
            "memory": {"root": "../memory", "scope": "agent_project"},
            "filesystem": {"writable": ["../work", "../outputs", "../memory"], "readonly": ["."]},
        },
    }


def _organization_agents(project_root: Path, organization: dict[str, Any]) -> dict[str, Path]:
    raw_agents = _require_mapping(organization.get("agents"), "organization agents are required.")
    agents: dict[str, Path] = {}
    for key, raw in raw_agents.items():
        agent_id = _clean_id(key, "agent id")
        data = _require_mapping(raw, f"organization agent is invalid: {agent_id}")
        workspace = _clean_text(data.get("workspace"), f"{agent_id}.workspace")
        resolved = (project_root / workspace).resolve()
        if not _is_relative_to(resolved, project_root):
            raise ValueError(f"Agent workspace escapes project root: {agent_id}")
        agents[agent_id] = resolved
    return agents


def _find_project_root(start: Path) -> Path | None:
    for path in (start, *start.parents):
        if (path / AITEAM_DIR / PROJECT_MANIFEST).is_file():
            return path
    return None


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


def _init_state_db(path: Path, *, project_id: str, default_agent: str) -> None:
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.executemany(
            "INSERT OR REPLACE INTO state_meta(key, value) VALUES(?, ?)",
            (("schema_version", "1"), ("project_id", project_id), ("default_agent", default_agent)),
        )


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
