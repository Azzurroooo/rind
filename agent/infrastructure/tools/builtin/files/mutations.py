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

from .operations import MAX_TEXT_FILE_SIZE


_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
_DIFF_MAX_LINES = 120
_DIFF_MAX_CHARS = 12_000


class _MutationError(Exception):
    def __init__(self, message: str, error_type: str, meta: dict | None = None) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.meta = meta


@dataclass(frozen=True, slots=True)
class _Hunk:
    lines: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class _PatchOperation:
    action: str
    path: Path
    expected_sha256: str | None
    content: str = ""
    hunks: tuple[_Hunk, ...] = ()


@dataclass(frozen=True, slots=True)
class _Mutation:
    path: Path
    before: bytes | None
    after: bytes | None
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


def _resolve_patch_path(raw_path: str) -> Path:
    candidate = Path(raw_path)
    if not raw_path or candidate.is_absolute() or candidate.drive or ".." in candidate.parts:
        raise _MutationError(f"Patch 路径必须是项目内的相对路径: {raw_path}", "InvalidPath")
    root = Path.cwd().resolve()
    try:
        resolved = (root / candidate).resolve()
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _MutationError(f"Patch 路径超出项目目录: {raw_path}", "InvalidPath") from exc
    if resolved == root:
        raise _MutationError("Patch 目标不能是项目根目录。", "InvalidPath")
    return resolved


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
    if len(raw) > MAX_TEXT_FILE_SIZE:
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
            if mutation.after is not None:
                staged[mutation.path] = _stage_file(mutation.path, mutation.after, mutation.mode)
        for mutation in mutations:
            _verify_unchanged(mutation)
        for mutation in mutations:
            if mutation.after is None:
                mutation.path.unlink()
            else:
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
    after = mutation.after.decode("utf-8") if mutation.after is not None else ""
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
            raise _MutationError(f"找到 {count} 处匹配的 old_str，请提供唯一上下文。", "OldStrNotUnique", {"count": count})
        mutation = _Mutation(path, before, text.replace(old_str, new_str).encode("utf-8"), mode)
        _commit_mutations([mutation])
        return _success("edit_file", [mutation])
    except Exception as exc:
        return _failure("edit_file", exc, "EditError")


def _parse_patch(patch: object) -> list[_PatchOperation]:
    if not isinstance(patch, str) or not patch:
        raise _MutationError("patch 必须是非空字符串。", "InvalidPatch")
    lines = patch.splitlines()
    if len(lines) < 3 or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
        raise _MutationError("Patch 必须使用 *** Begin Patch / *** End Patch 格式。", "InvalidPatch")

    operations: list[_PatchOperation] = []
    seen_paths: set[str] = set()
    index = 1
    while index < len(lines) - 1:
        header = lines[index]
        action = ""
        raw_path = ""
        for candidate in ("Add", "Update", "Delete"):
            prefix = f"*** {candidate} File: "
            if header.startswith(prefix):
                action = candidate.lower()
                raw_path = header[len(prefix):]
                break
        if not action:
            raise _MutationError(f"无效的 Patch 文件头: {header}", "InvalidPatch")
        path = _resolve_patch_path(raw_path)
        path_key = os.path.normcase(str(path))
        if path_key in seen_paths:
            raise _MutationError(f"Patch 包含重复目标: {raw_path}", "DuplicatePath")
        seen_paths.add(path_key)
        index += 1

        expected: str | None = None
        if action in {"update", "delete"}:
            if index >= len(lines) - 1 or not lines[index].startswith("*** Expected SHA256: "):
                raise _MutationError(f"{raw_path} 缺少 *** Expected SHA256 指令。", "PreimageRequired")
            expected = _normalize_sha256(lines[index][len("*** Expected SHA256: "):], required=True)
            index += 1

        if action == "add":
            content_lines: list[str] = []
            while index < len(lines) - 1 and not lines[index].startswith("*** "):
                if not lines[index].startswith("+"):
                    raise _MutationError("Add File 的每一行都必须以 + 开头。", "InvalidPatch")
                content_lines.append(lines[index][1:])
                index += 1
            content = "\n".join(content_lines) + ("\n" if content_lines else "")
            operations.append(_PatchOperation(action, path, None, content=content))
            continue

        if action == "delete":
            operations.append(_PatchOperation(action, path, expected))
            continue

        hunks: list[_Hunk] = []
        while index < len(lines) - 1 and not lines[index].startswith("*** "):
            if lines[index] != "@@":
                raise _MutationError("Update File 的 hunk 必须以 @@ 开头。", "InvalidPatch")
            index += 1
            hunk_lines: list[tuple[str, str]] = []
            while index < len(lines) - 1 and lines[index] != "@@" and not lines[index].startswith("*** "):
                line = lines[index]
                if not line or line[0] not in {" ", "+", "-"}:
                    raise _MutationError("Hunk 行必须以空格、+ 或 - 开头。", "InvalidPatch")
                hunk_lines.append((line[0], line[1:]))
                index += 1
            if not hunk_lines:
                raise _MutationError("Patch hunk 不能为空。", "InvalidPatch")
            hunks.append(_Hunk(tuple(hunk_lines)))
        if not hunks:
            raise _MutationError("Update File 至少需要一个 hunk。", "InvalidPatch")
        operations.append(_PatchOperation(action, path, expected, hunks=tuple(hunks)))

    if not operations:
        raise _MutationError("Patch 不包含文件操作。", "InvalidPatch")
    return operations


def _apply_hunks(text: str, hunks: tuple[_Hunk, ...], path: Path) -> str:
    lines = text.splitlines()
    newline_match = re.search(r"\r\n|\n|\r", text)
    newline = newline_match.group(0) if newline_match else "\n"
    ends_with_newline = text.endswith(("\r\n", "\n", "\r"))
    cursor = 0
    for hunk in hunks:
        old_lines = [value for kind, value in hunk.lines if kind in {" ", "-"}]
        new_lines = [value for kind, value in hunk.lines if kind in {" ", "+"}]
        if not old_lines:
            raise _MutationError(f"Hunk 缺少可校验的 context/removed 行: {path}", "InvalidPatch")
        matches = [
            position
            for position in range(cursor, len(lines) - len(old_lines) + 1)
            if lines[position:position + len(old_lines)] == old_lines
        ]
        if not matches:
            raise _MutationError(f"Patch context 与当前文件不匹配: {path}", "PatchMismatch")
        if len(matches) > 1:
            raise _MutationError(f"Patch context 在文件中不唯一: {path}", "PatchContextNotUnique")
        position = matches[0]
        lines[position:position + len(old_lines)] = new_lines
        cursor = position + len(new_lines)
    result = newline.join(lines)
    if lines and ends_with_newline:
        result += newline
    return result


def _plan_patch(operations: list[_PatchOperation]) -> list[_Mutation]:
    mutations: list[_Mutation] = []
    for operation in operations:
        if operation.action == "add":
            if operation.path.exists():
                error_type = "NotAFile" if not operation.path.is_file() else "AlreadyExists"
                raise _MutationError(f"Add File 目标已存在: {operation.path}", error_type)
            mutations.append(_Mutation(operation.path, None, operation.content.encode("utf-8"), None))
            continue
        before, text, mode = _read_existing(operation.path, operation.expected_sha256)
        if operation.action == "delete":
            mutations.append(_Mutation(operation.path, before, None, mode))
        else:
            updated = _apply_hunks(text, operation.hunks, operation.path)
            mutations.append(_Mutation(operation.path, before, updated.encode("utf-8"), mode))
    return mutations


def apply_patch(patch: str) -> str:
    """Apply a strict Codex-style multi-file patch after validating every preimage."""
    try:
        mutations = _plan_patch(_parse_patch(patch))
        _commit_mutations(mutations)
        return _success("apply_patch", mutations)
    except Exception as exc:
        return _failure("apply_patch", exc, "PatchApplyError")
