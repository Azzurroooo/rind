"""File tool registration with optional Capsule workspace binding."""

from __future__ import annotations

from collections.abc import Collection
from pathlib import Path

from agent.domain import tool_error
from agent.domain.cancellation import CancellationToken

from ...spec import ToolSpec
from .mutations import edit_file, write_file
from .operations import glob, grep, read_file


def build_file_tool_specs(
    workspace_root: str | Path | None = None,
    allowed_roots: Collection[str | Path] | None = None,
    shared_root: str | Path | None = None,
    session_output_root: str | Path | None = None,
) -> tuple[ToolSpec, ...]:
    if workspace_root is None and allowed_roots is None and shared_root is None and session_output_root is None:
        return TOOL_SPECS
    root = Path(workspace_root or Path.cwd()).expanduser().resolve()
    allowed = tuple(Path(path).expanduser().resolve() for path in (allowed_roots or ()))
    shared = Path(shared_root).expanduser().resolve() if shared_root is not None else None
    session_output = Path(session_output_root).expanduser().resolve() if session_output_root is not None else None

    def resolve_path(
        tool_name: str,
        value: str,
        allow_session_output: bool = False,
    ) -> tuple[str | None, str | None]:
        if not isinstance(value, str) or not value.strip():
            return None, tool_error(tool_name, "Path is required.", "InvalidPath")
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            if shared is not None and candidate.parts and candidate.parts[0].casefold() == "shared":
                candidate = shared.joinpath(*candidate.parts[1:])
            else:
                candidate = root / candidate
        candidate = candidate.resolve()
        if allowed and not any(_is_relative_to(candidate, allowed_root) for allowed_root in allowed):
            if allow_session_output and session_output is not None and _is_relative_to(candidate, session_output):
                return str(candidate), None
            return None, tool_error(tool_name, f"Path is outside this Agent Capsule: {value}", "WorkspaceBoundary")
        return str(candidate), None

    def scoped_read_file(
        path: str,
        offset: int = 1,
        limit: int = 1000,
        _cancellation_token: CancellationToken | None = None,
    ) -> str:
        resolved, error = resolve_path("read_file", path, allow_session_output=True)
        return error or read_file(resolved, offset, limit, _cancellation_token)

    def scoped_write_file(file_path: str, content: str, expected_sha256: str | None = None) -> str:
        resolved, error = resolve_path("write_file", file_path)
        return error or write_file(resolved, content, expected_sha256)

    def scoped_edit_file(file_path: str, old_str: str, new_str: str, expected_sha256: str) -> str:
        resolved, error = resolve_path("edit_file", file_path)
        return error or edit_file(resolved, old_str, new_str, expected_sha256)

    def scoped_glob(
        pattern: str,
        path: str = ".",
        max_results: int = 1000,
        _cancellation_token: CancellationToken | None = None,
    ) -> str:
        resolved, error = resolve_path("glob", path)
        return error or glob(pattern, resolved, max_results, _cancellation_token)

    def scoped_grep(
        pattern: str,
        path: str = ".",
        glob: str = "**/*",
        max_results: int = 1000,
        _cancellation_token: CancellationToken | None = None,
    ) -> str:
        resolved, error = resolve_path("grep", path)
        return error or grep(pattern, resolved, glob, max_results, _cancellation_token)

    return _specs(scoped_read_file, scoped_write_file, scoped_edit_file, scoped_glob, scoped_grep)


def _specs(read, write, edit, find, search) -> tuple[ToolSpec, ...]:
    return (
        ToolSpec(
            name="read_file",
            handler=read,
            description="读取 UTF-8 文本文件的指定行范围，单页最多 2000 行和约 50 KiB，返回行号、截断状态、下一次 offset 和完整文件 SHA-256。",
            param_descriptions={
                "path": "文件绝对或相对路径",
                "offset": "起始行号（默认 1）",
                "limit": "最多读取的行数（默认 1000 行，最大 2000 行；单页约 50 KiB，超过会被截断）",
            },
        ),
        ToolSpec(
            name="write_file",
            handler=write,
            description="原子新建 UTF-8 文本文件，或在 expected_sha256 匹配时完整覆盖已有文件。",
            param_descriptions={
                "file_path": "文件绝对或相对路径",
                "content": "完整文件内容",
                "expected_sha256": "覆盖已有文件时必填，必须使用最近一次 read_file 返回的 sha256；新建文件时省略。",
            },
        ),
        ToolSpec(
            name="edit_file",
            handler=edit,
            description="在 expected_sha256 匹配时原子替换已有 UTF-8 文件中的唯一文本块。old_str 必须与文件内容完全一致。",
            param_descriptions={
                "file_path": "文件绝对或相对路径",
                "old_str": "需要被替换的原文块。建议包含上下文以确保唯一。",
                "new_str": "用来替换 old_str 的新文本块。",
                "expected_sha256": "必填，必须使用最近一次 read_file 返回的 sha256。",
            },
        ),
        ToolSpec(
            name="glob",
            handler=find,
            description="按 glob 模式快速查找文件路径，并返回文件大小。适合在读取文件内容前定位候选文件。",
            param_descriptions={
                "pattern": "文件匹配模式，如 **/*.py、src/**/*.ts。",
                "path": "搜索目录。默认为当前目录 .。",
                "max_results": "最大返回文件数。默认 1000。",
            },
        ),
        ToolSpec(
            name="grep",
            handler=search,
            description="使用 rg 在文件中搜索模式，返回匹配文件、行号和文本。达到上限时返回截断状态。",
            param_descriptions={
                "pattern": "要搜索的正则表达式（rg 语法）",
                "path": "搜索的根目录 (默认为当前目录 .)",
                "glob": "文件匹配模式 (如 **/*.py, src/*.ts)。默认为 **/*。",
                "max_results": "最大返回结果数。默认 1000。",
            },
        ),
    )


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


TOOL_SPECS = _specs(read_file, write_file, edit_file, glob, grep)


__all__ = ["TOOL_SPECS", "build_file_tool_specs", "edit_file", "glob", "grep", "read_file", "write_file"]
