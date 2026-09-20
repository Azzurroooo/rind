"""Team project and member types."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
