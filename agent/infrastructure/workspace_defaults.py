"""Per-folder defaults for new conversations, kept in RIND_HOME/workspaces.json.

A folder (a workspace, so also a team member) may set two independent groups:
the model (connection and model, always together) and the reasoning effort.
A Git worktree without its own value uses its main repository's. Whatever no
folder sets comes from the user's settings.json. The answer is read once, when
a conversation is created; the conversation keeps it from then on.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Literal

from filelock import FileLock

from agent.domain.models import ModelSelection
from agent.infrastructure.paths import resolve_rind_home
from agent.infrastructure.settings import normalize_reasoning_effort


Source = Literal["folder", "main_repository", "settings"]


@dataclass(frozen=True, slots=True)
class FolderSelection:
    """The selection a new conversation in a folder starts with, and where each part came from."""

    selection: ModelSelection
    model_source: Source
    effort_source: Source


class WorkspaceDefaults:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path or (resolve_rind_home() / "workspaces.json")).expanduser().resolve()
        self._lock = FileLock(str(self.path) + ".lock")

    def get(self, workspace_root: str) -> dict[str, str]:
        """What this folder itself sets: provider and model, and/or reasoning_effort."""
        entry = self._read().get(_key(workspace_root))
        return dict(entry) if isinstance(entry, dict) else {}

    def set_model(self, workspace_root: str, provider: str, model: str) -> None:
        provider, model = str(provider or "").strip(), str(model or "").strip()
        if not provider or not model:
            raise ValueError("A folder default model needs both a connection and a model.")
        self._update(workspace_root, {"provider": provider, "model": model})

    def set_reasoning_effort(self, workspace_root: str, effort: str) -> None:
        clean = normalize_reasoning_effort(effort)
        if not clean:
            raise ValueError("Reasoning effort is required.")
        self._update(workspace_root, {"reasoning_effort": clean})

    def unset(self, workspace_root: str, group: Literal["model", "reasoning_effort"]) -> bool:
        keys = ("provider", "model") if group == "model" else ("reasoning_effort",)
        with self._lock:
            data = self._read()
            key = _key(workspace_root)
            entry = {name: value for name, value in data.get(key, {}).items() if name not in keys}
            if entry == data.get(key, {}):
                return False
            self._write({name: value for name, value in data.items() if name != key} | ({key: entry} if entry else {}))
            return True

    def resolve(self, workspace_root: str, fallback: ModelSelection, *, own: bool = True) -> FolderSelection:
        """The folder's values, else its main repository's (a worktree), else `fallback` (settings.json).

        With own=False the folder's own values are skipped: what it falls back to once they are cleared.
        """
        layers: list[tuple[dict[str, str], Source]] = [(self.get(workspace_root), "folder")] if own else []
        main = main_repository(workspace_root)
        if main is not None:
            layers.append((self.get(str(main)), "main_repository"))
        model = next(((entry, source) for entry, source in layers if entry.get("model")), None)
        effort = next(((entry, source) for entry, source in layers if entry.get("reasoning_effort")), None)
        return FolderSelection(
            selection=ModelSelection(
                model[0]["provider"] if model else fallback.provider_id,
                model[0]["model"] if model else fallback.model_id,
                effort[0]["reasoning_effort"] if effort else fallback.reasoning_effort,
            ),
            model_source=model[1] if model else "settings",
            effort_source=effort[1] if effort else "settings",
        )

    def _update(self, workspace_root: str, values: dict[str, str]) -> None:
        with self._lock:
            data = self._read()
            key = _key(workspace_root)
            self._write(data | {key: dict(data.get(key, {})) | values})

    def _read(self) -> dict[str, Any]:
        with self._lock:
            if not self.path.exists():
                return {}
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid workspaces.json: {self.path} ({exc})") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Invalid workspaces.json: {self.path} must contain a JSON object")
            return {key: entry for key, entry in value.items() if isinstance(entry, dict)}

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        temporary = Path(temporary_name)
        try:
            os.close(fd)
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)


def main_repository(workspace_root: str) -> Path | None:
    """The main checkout a Git worktree belongs to, read from its .git file; None otherwise."""
    marker = Path(workspace_root) / ".git"
    try:
        if not marker.is_file():
            return None
        text = marker.read_text(encoding="utf-8").strip()
        if not text.startswith("gitdir:"):
            return None
        git_dir = (marker.parent / text.removeprefix("gitdir:").strip()).resolve()
        common = git_dir / "commondir"
        common_dir = (git_dir / common.read_text(encoding="utf-8").strip()).resolve() if common.is_file() else git_dir.parent.parent
    except OSError:
        return None
    # A bare repository has no checkout of its own to inherit from.
    if common_dir.name != ".git" or not common_dir.parent.is_dir():
        return None
    return common_dir.parent


def _key(workspace_root: str) -> str:
    return os.path.normcase(str(Path(workspace_root).expanduser().resolve()))
