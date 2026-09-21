"""Resolve explicit uploads references when user input enters a session."""

import os
from pathlib import Path, PurePosixPath

from agent.domain.images import upload_references


def resolve_upload_path(workspace_root: str | Path | None, rel_path: str) -> Path | None:
    """Resolve an uploads-relative path, returning None for any unsafe path."""
    if not workspace_root or not rel_path:
        return None
    candidate = PurePosixPath(rel_path)
    if candidate.is_absolute() or not candidate.parts or candidate.parts[0] != "uploads":
        return None
    if any(part in ("", ".", "..") for part in candidate.parts):
        return None
    try:
        root = Path(workspace_root)
        resolved = (root / Path(*candidate.parts)).resolve()
        if not resolved.is_relative_to(root.resolve()):
            return None
        real_root = Path(os.path.realpath(root))
        if not Path(os.path.realpath(resolved)).is_relative_to(real_root):
            return None
    except (OSError, ValueError):
        return None
    return resolved


def upload_paths(text: str, workspace_root: str | None) -> list[Path]:
    paths = []
    for relative in upload_references(text):
        path = resolve_upload_path(workspace_root, relative)
        if path is None or not path.is_file():
            raise ValueError(f"Image reference is missing or outside the workspace: {relative}")
        paths.append(path)
    return paths
