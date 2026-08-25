"""Version-checked, atomic UTF-8 file mutation tools."""

from __future__ import annotations

from dataclasses import dataclass
import difflib
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile

from agent.domain import tool_error, tool_ok

_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
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


def _normalize_sha256(value: object, *, required: bool) -> str | None:
    if value is None or value == "":
        if required:
            raise _MutationError(
                "修改已有文件前必须提供 read_file 返回的 expected_sha256。",
                "PreimageRequired",
            )
        return None
    if not isinstance(value, str) or not _SHA256_PATTERN.fullmatch(value):
        raise _MutationError("expected_sha256 必须是 64 位十六进制 SHA-256。", "InvalidExpectedSha256")
    return value.lower()


def _resolve_path(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise _MutationError("文件路径不能为空。", "InvalidPath")
    try:
        return Path(raw_path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError) as exc:
        raise _MutationError(f"无效的文件路径: {raw_path}: {exc}", "InvalidPath") from exc


def _read_existing(path: Path, expected_sha256: object) -> tuple[bytes, str, int]:
    if not path.exists():
        raise _MutationError(f"文件不存在: {path}", "NotFound")
    if not path.is_file():
        raise _MutationError(f"路径不是文件: {path}", "NotAFile")
    expected = _normalize_sha256(expected_sha256, required=True)
    try:
        raw = path.read_bytes()
        mode = stat.S_IMODE(path.stat().st_mode)
    except PermissionError as exc:
        raise _MutationError(f"无权读取文件: {path}", "PermissionDenied") from exc
    except OSError as exc:
        raise _MutationError(f"读取文件失败: {path}: {exc}", "ReadError") from exc
    if len(raw) > _MAX_WRITE_FILE_SIZE:
        raise _MutationError("文件过大（>10MB），无法进行全量编辑。", "FileTooLarge")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _MutationError(f"文件不是有效的 UTF-8 文本: {path}", "InvalidEncoding") from exc
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise _MutationError(
            f"文件已发生变化，请重新读取后再编辑: {path}",
            "PreimageMismatch",
            {"path": str(path), "expected_sha256": expected, "actual_sha256": actual},
        )
    return raw, text, mode


def _stage_file(path: Path, content: bytes, mode: int | None) -> Path:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except FileExistsError as exc:
        raise _MutationError(f"父路径不是目录: {path.parent}", "NotADirectory") from exc
    if not path.parent.is_dir():
        raise _MutationError(f"父路径不是目录: {path.parent}", "NotADirectory")
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
                f"目标在写入前已被创建: {mutation.path}",
                "PreimageMismatch",
                {"path": str(mutation.path)},
            )
        return
    try:
        current = mutation.path.read_bytes()
    except (OSError, ValueError) as exc:
        raise _MutationError(
            f"文件在写入前已发生变化: {mutation.path}",
            "PreimageMismatch",
            {"path": str(mutation.path)},
        ) from exc
    if current != mutation.before:
        raise _MutationError(
            f"文件在写入前已发生变化: {mutation.path}",
            "PreimageMismatch",
            {"path": str(mutation.path), "actual_sha256": hashlib.sha256(current).hexdigest()},
        )


def _commit_mutations(mutations: list[_Mutation]) -> None:
    staged: dict[Path, Path] = {}
    try:
        for mutation in mutations:
            staged[mutation.path] = _stage_file(mutation.path, mutation.after, mutation.mode)
        for mutation in mutations:
            _verify_unchanged(mutation)
        for mutation in mutations:
            os.replace(staged[mutation.path], mutation.path)
    finally:
        for temp_path in staged.values():
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


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


def _success(tool_name: str, mutations: list[_Mutation]) -> str:
    return tool_ok(
        tool_name,
        f"成功修改 {len(mutations)} 个文件。",
        meta={"files": [_file_meta(mutation) for mutation in mutations]},
    )


def _failure(tool_name: str, exc: Exception, fallback_type: str) -> str:
    if isinstance(exc, _MutationError):
        return tool_error(tool_name, str(exc), exc.error_type, meta=exc.meta)
    if isinstance(exc, PermissionError):
        return tool_error(tool_name, f"文件操作无权限: {exc}", "PermissionDenied")
    return tool_error(tool_name, f"文件操作失败: {exc}", fallback_type)


def write_file(file_path: str, content: str, expected_sha256: str | None = None) -> str:
    """Create a UTF-8 file, or atomically replace a version-checked existing file."""
    try:
        if not isinstance(content, str):
            raise _MutationError("content 必须是字符串。", "InvalidContent")
        path = _resolve_path(file_path)
        if path.exists():
            before, _, mode = _read_existing(path, expected_sha256)
        else:
            supplied = _normalize_sha256(expected_sha256, required=False)
            if supplied is not None:
                raise _MutationError(f"预期文件存在，但目标不存在: {path}", "PreimageMismatch")
            before, mode = None, None
        mutation = _Mutation(path, before, content.encode("utf-8"), mode)
        _commit_mutations([mutation])
        return _success("write_file", [mutation])
    except Exception as exc:
        return _failure("write_file", exc, "WriteError")


def edit_file(file_path: str, old_str: str, new_str: str, expected_sha256: str) -> str:
    """Replace one exact text occurrence in a version-checked UTF-8 file."""
    try:
        if not isinstance(old_str, str) or not old_str or not isinstance(new_str, str):
            raise _MutationError("old_str 必须是非空字符串，new_str 必须是字符串。", "InvalidContent")
        path = _resolve_path(file_path)
        before, text, mode = _read_existing(path, expected_sha256)
        count = text.count(old_str)
        if count == 0:
            raise _MutationError("在文件中找不到指定的 old_str。", "OldStrNotFound")
        if count > 1:
            raise _MutationError(
                f"找到 {count} 处匹配的 old_str，请提供唯一上下文。",
                "OldStrNotUnique",
                {"count": count},
            )
        mutation = _Mutation(path, before, text.replace(old_str, new_str).encode("utf-8"), mode)
        _commit_mutations([mutation])
        return _success("edit_file", [mutation])
    except Exception as exc:
        return _failure("edit_file", exc, "EditError")
