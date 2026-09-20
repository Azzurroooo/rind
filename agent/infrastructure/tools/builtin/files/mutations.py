"""Atomic UTF-8 file mutations with commit-time conflict detection."""

from __future__ import annotations

from dataclasses import dataclass
import difflib
import os
from pathlib import Path
import stat
import tempfile

from agent.domain import tool_error, tool_ok

_MAX_WRITE_FILE_SIZE = 10 * 1024 * 1024
_DIFF_MAX_LINES = 120
_DIFF_MAX_CHARS = 12_000


class _MutationError(Exception):
    def __init__(self, message: str, error_type: str, meta: dict | None = None) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.meta = meta


@dataclass(frozen=True, slots=True)
class _Mutation:
    path: Path
    before: bytes | None
    after: bytes
    mode: int | None


def _resolve_path(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise _MutationError("File path must not be empty.", "InvalidPath")
    try:
        return Path(raw_path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError) as exc:
        raise _MutationError(f"Invalid file path: {raw_path}: {exc}", "InvalidPath") from exc


def _read_existing(path: Path) -> tuple[bytes, str, int]:
    if not path.exists():
        raise _MutationError(f"File does not exist: {path}", "NotFound")
    if not path.is_file():
        raise _MutationError(f"Path is not a file: {path}", "NotAFile")
    try:
        raw = path.read_bytes()
        mode = stat.S_IMODE(path.stat().st_mode)
    except PermissionError as exc:
        raise _MutationError(f"Permission denied reading file: {path}", "PermissionDenied") from exc
    except OSError as exc:
        raise _MutationError(f"Failed to read file: {path}: {exc}", "ReadError") from exc
    if len(raw) > _MAX_WRITE_FILE_SIZE:
        raise _MutationError("File is too large (>10MB) for a full-content edit.", "FileTooLarge")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _MutationError(f"File is not valid UTF-8 text: {path}", "InvalidEncoding") from exc
    return raw, text, mode


def _stage_file(path: Path, content: bytes, mode: int | None) -> Path:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except FileExistsError as exc:
        raise _MutationError(f"Parent path is not a directory: {path.parent}", "NotADirectory") from exc
    if not path.parent.is_dir():
        raise _MutationError(f"Parent path is not a directory: {path.parent}", "NotADirectory")
    file_descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(file_descriptor, "wb") as temp_file:
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        if mode is not None:
            os.chmod(temp_path, mode)
        return temp_path
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _verify_unchanged(mutation: _Mutation) -> None:
    if mutation.before is None:
        if mutation.path.exists():
            raise _MutationError(
                f"Target was created before the write: {mutation.path}",
                "PreimageMismatch",
                {"path": str(mutation.path)},
            )
        return
    try:
        current = mutation.path.read_bytes()
    except (OSError, ValueError) as exc:
        raise _MutationError(
            f"File changed before the write: {mutation.path}",
            "PreimageMismatch",
            {"path": str(mutation.path)},
        ) from exc
    if current != mutation.before:
        raise _MutationError(
            f"File changed before the write: {mutation.path}",
            "PreimageMismatch",
            {"path": str(mutation.path)},
        )


def _commit_mutation(mutation: _Mutation) -> None:
    staged = _stage_file(mutation.path, mutation.after, mutation.mode)
    try:
        _verify_unchanged(mutation)
        os.replace(staged, mutation.path)
    finally:
        staged.unlink(missing_ok=True)


def _diff_stats(before: str, after: str) -> tuple[int, int]:
    matcher = difflib.SequenceMatcher(None, before.splitlines(keepends=True), after.splitlines(keepends=True))
    added = 0
    removed = 0
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag in {"replace", "delete"}:
            removed += old_end - old_start
        if tag in {"replace", "insert"}:
            added += new_end - new_start
    return added, removed


def _bounded_diff(path: Path, before: str, after: str) -> str:
    diff = difflib.unified_diff(
        before.splitlines(),
        after.splitlines(),
        fromfile=str(path),
        tofile=str(path),
        n=3,
        lineterm="",
    )
    lines: list[str] = []
    chars = 0
    truncated = False
    for line in diff:
        if len(lines) >= _DIFF_MAX_LINES or chars + len(line) + 1 > _DIFF_MAX_CHARS:
            truncated = True
            break
        lines.append(line)
        chars += len(line) + 1
    result = "\n".join(lines)
    if truncated:
        marker = "\n... diff truncated ..."
        result = result[:_DIFF_MAX_CHARS - len(marker)] + marker
    return result


def _file_meta(mutation: _Mutation) -> dict[str, object]:
    before = mutation.before.decode("utf-8") if mutation.before is not None else ""
    after = mutation.after.decode("utf-8")
    added, removed = _diff_stats(before, after)
    return {
        "path": str(mutation.path),
        "added_lines": added,
        "removed_lines": removed,
        "diff": _bounded_diff(mutation.path, before, after),
    }


def _success(tool_name: str, mutation: _Mutation) -> str:
    return tool_ok(
        tool_name,
        "Successfully modified 1 file.",
        meta={"files": [_file_meta(mutation)]},
    )


def _failure(tool_name: str, exc: Exception, fallback_type: str) -> str:
    if isinstance(exc, _MutationError):
        return tool_error(tool_name, str(exc), exc.error_type, meta=exc.meta)
    if isinstance(exc, PermissionError):
        return tool_error(tool_name, f"Permission denied during file operation: {exc}", "PermissionDenied")
    return tool_error(tool_name, f"File operation failed: {exc}", fallback_type)


def write_file(file_path: str, content: str) -> str:
    """Create or fully overwrite a UTF-8 file."""
    try:
        if not isinstance(content, str):
            raise _MutationError("content must be a string.", "InvalidContent")
        path = _resolve_path(file_path)
        if path.exists():
            before, _, mode = _read_existing(path)
        else:
            before, mode = None, None
        mutation = _Mutation(path, before, content.encode("utf-8"), mode)
        _commit_mutation(mutation)
        return _success("write_file", mutation)
    except Exception as exc:
        return _failure("write_file", exc, "WriteError")


def edit_file(file_path: str, old_str: str, new_str: str) -> str:
    """Replace one unique, exact text occurrence in the current file."""
    try:
        if not isinstance(old_str, str) or not old_str or not isinstance(new_str, str):
            raise _MutationError("old_str must be a non-empty string and new_str must be a string.", "InvalidContent")
        path = _resolve_path(file_path)
        before, text, mode = _read_existing(path)
        start = text.find(old_str)
        if start < 0:
            raise _MutationError("The specified old_str was not found in the file.", "OldStrNotFound")
        if start != text.rfind(old_str):
            raise _MutationError(
                "Found multiple matches for old_str; provide unique context.",
                "OldStrNotUnique",
            )
        mutation = _Mutation(path, before, text.replace(old_str, new_str).encode("utf-8"), mode)
        _commit_mutation(mutation)
        return _success("edit_file", mutation)
    except Exception as exc:
        return _failure("edit_file", exc, "EditError")
