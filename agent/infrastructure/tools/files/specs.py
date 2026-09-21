"""File tool registration with optional Capsule workspace binding."""

from __future__ import annotations

from collections.abc import Collection
from pathlib import Path

from agent.domain import tool_error
from agent.domain.cancellation import CancellationToken
from agent.infrastructure.tools.files.mutation_queue import FileMutationQueue
from agent.infrastructure.tools.files.mutations import edit_file, write_file
from agent.infrastructure.tools.files.queries import glob, grep, read_file
from agent.infrastructure.tools.spec import ToolSpec


def _normalize_path_arguments(args: dict) -> dict:
    if "file_path" in args:
        legacy = args.pop("file_path")
        if "path" in args and args["path"] != legacy:
            raise ValueError("Conflicting path and file_path; supply only path.")
        args["path"] = legacy
    return args


def _normalize_mutation_arguments(args: dict) -> dict:
    args.pop("expected_sha256", None)
    return _normalize_path_arguments(args)


def build_file_tool_specs(
    workspace_root: str | Path | None = None,
    allowed_roots: Collection[str | Path] | None = None,
    shared_root: str | Path | None = None,
    session_output_root: str | Path | None = None,
    *,
    mutation_queue: FileMutationQueue | None = None,
    capture_image=None,
    image_input: bool | None = None,
    session_base_provider=None,
) -> tuple[ToolSpec, ...]:
    mutation_queue = mutation_queue if mutation_queue is not None else FileMutationQueue()
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
        if allowed and not any(candidate.is_relative_to(allowed_root) for allowed_root in allowed):
            if allow_session_output and session_output is not None and candidate.is_relative_to(session_output):
                return str(candidate), None
            base = session_base_provider() if session_base_provider is not None else None
            if allow_session_output and base and candidate.is_relative_to(Path(base).resolve() / "attachments"):
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
        return error or read_file(resolved, offset, limit, _cancellation_token, capture_image=capture_image, image_input=image_input)

    async def scoped_write_file(
        path: str, content: str, _cancellation_token: CancellationToken | None = None,
    ) -> str:
        resolved, error = resolve_path("write_file", path)
        return error or await mutation_queue.run(
            resolved, lambda: write_file(resolved, content),
            tool_name="write_file", cancellation_token=_cancellation_token,
        )

    async def scoped_edit_file(
        path: str, old_str: str, new_str: str, _cancellation_token: CancellationToken | None = None,
    ) -> str:
        resolved, error = resolve_path("edit_file", path)
        return error or await mutation_queue.run(
            resolved, lambda: edit_file(resolved, old_str, new_str),
            tool_name="edit_file", cancellation_token=_cancellation_token,
        )

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
            normalize_arguments=_normalize_path_arguments,
            description="Read UTF-8 text or a local image (PNG, JPEG, WebP, GIF, BMP). Images are sent as attachments, resized to at most 2000 pixels per edge; animations use the first frame. Omit offset/limit for images. Text reads return complete lines within a 25 KiB model budget, including next_offset. For LineTooLong, read character slices with bash/Python.",
            param_descriptions={
                "path": "Absolute or relative file path",
                "offset": "First line to read (default 1)",
                "limit": "Maximum lines to read (default 1000, maximum 2000; a page is about 50 KiB with a 25 KiB model preview)",
            },
        ),
        ToolSpec(
            name="write_file",
            handler=write,
            normalize_arguments=_normalize_mutation_arguments,
            description="Atomically create or fully overwrite a UTF-8 text file. Use for new files or complete rewrites. Edits and writes to the same file run in order. No hash parameter is needed.",
            param_descriptions={
                "path": "Absolute or relative file path",
                "content": "Full file content",
            },
        ),
        ToolSpec(
            name="edit_file",
            handler=edit,
            normalize_arguments=_normalize_mutation_arguments,
            description="Atomically replace one unique, exact text block in the current UTF-8 file. Edits and writes to the same file run in order; later edits see earlier changes. No hash parameter is needed.",
            param_descriptions={
                "path": "Absolute or relative file path",
                "old_str": "Text block to replace. Include surrounding context to make it unique.",
                "new_str": "Replacement text block for old_str.",
            },
        ),
        ToolSpec(
            name="glob",
            handler=find,
            normalize_arguments=_normalize_path_arguments,
            description="Fast glob-pattern file lookup that returns paths and file sizes. Use it to locate candidate files before reading their contents.",
            param_descriptions={
                "pattern": "Glob pattern such as **/*.py or src/**/*.ts.",
                "path": "Directory to search. Defaults to the current directory.",
                "max_results": "Maximum number of files returned. Default 1000.",
            },
        ),
        ToolSpec(
            name="grep",
            handler=search,
            normalize_arguments=_normalize_path_arguments,
            description="Search file contents with rg; returns matching files, line numbers, and text. Reports truncation when the result cap is hit.",
            param_descriptions={
                "pattern": "Regular expression to search for (rg syntax)",
                "path": "Root directory to search (defaults to the current directory)",
                "glob": "File glob pattern (e.g. **/*.py, src/*.ts). Defaults to **/*.",
                "max_results": "Maximum number of matches returned. Default 1000.",
            },
        ),
    )
__all__ = ["build_file_tool_specs", "edit_file", "glob", "grep", "read_file", "write_file"]
