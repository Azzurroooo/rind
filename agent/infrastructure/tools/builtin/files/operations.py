"""文件导航工具定义。"""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from agent.domain import tool_cancelled, tool_error, tool_ok
from agent.domain.cancellation import CancellationToken


_SKIP_DIRS = frozenset({
    ".git", "node_modules", "venv", ".venv", "__pycache__",
    "dist", "build", ".mypy_cache", ".pytest_cache", ".tox",
    ".hg", ".svn", "site-packages",
})
_READ_MAX_LIMIT = 2000
_READ_MAX_BYTES = 50 * 1024
_MAX_LINE_CHARS = 2000


def _cancelled(tool_name: str, token: CancellationToken | None) -> str | None:
    if token and token.is_cancelled:
        return tool_cancelled(tool_name, token.reason)
    return None


def _existing_path(tool_name: str, raw_path: str) -> tuple[Path, str | None]:
    try:
        path = Path(raw_path).expanduser().resolve()
        path.stat()
    except FileNotFoundError:
        return Path(raw_path), tool_error(tool_name, f"路径不存在: {raw_path}", "NotFound")
    except PermissionError:
        return Path(raw_path), tool_error(tool_name, f"无权访问路径: {raw_path}", "PermissionDenied")
    except OSError as exc:
        return Path(raw_path), tool_error(tool_name, f"无法访问路径: {raw_path}: {exc}", "PathAccessError")
    return path, None


def _is_skipped_path(path: Path) -> bool:
    return bool(_SKIP_DIRS & set(path.parts))


def _relative_path(file_path: Path, root: Path) -> str:
    base = root if root.is_dir() else root.parent
    try:
        return file_path.relative_to(base).as_posix()
    except ValueError:
        return file_path.as_posix()


def _clip_text(text: str, limit: int = _MAX_LINE_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"...(truncated:{len(text)})"


def _looks_binary(sample: bytes) -> bool:
    if b"\x00" in sample:
        return True
    controls = sum(byte < 32 and byte not in {9, 10, 12, 13} for byte in sample)
    return bool(sample) and controls / len(sample) > 0.1


def read_file(
    path: str,
    offset: int = 1,
    limit: int = 1000,
    _cancellation_token: CancellationToken | None = None,
) -> str:
    if cancelled := _cancelled("read_file", _cancellation_token):
        return cancelled

    file_path, error = _existing_path("read_file", path)
    if error:
        return error
    if not file_path.is_file():
        return tool_error("read_file", f"路径不是文件: {path}", "NotAFile")

    try:
        offset = int(offset)
    except (TypeError, ValueError, OverflowError):
        return tool_error("read_file", "offset 必须是整数。", "InvalidOffset")
    try:
        requested_limit = int(limit)
    except (TypeError, ValueError, OverflowError):
        return tool_error("read_file", "limit 必须是整数。", "InvalidLimit")
    if offset < 1:
        return tool_error("read_file", "offset 必须 >= 1。", "InvalidOffset")
    if requested_limit < 1:
        return tool_error("read_file", "limit 必须 >= 1。", "InvalidLimit")

    try:
        with file_path.open("rb") as raw_file:
            sample = raw_file.read(8192)
            digest = hashlib.sha256()
            digest.update(sample)
            for chunk in iter(lambda: raw_file.read(1024 * 1024), b""):
                digest.update(chunk)
        if _looks_binary(sample):
            return tool_error("read_file", f"二进制文件不可按文本读取: {path}", "BinaryFile")

        effective_limit = min(requested_limit, _READ_MAX_LIMIT)
        end_line = offset + effective_limit - 1
        selected: list[tuple[int, str]] = []
        has_more = False
        line_truncated = False
        last_line = 0
        output_bytes = len(f"Showing lines {offset} to 0:".encode("utf-8"))
        with file_path.open("r", encoding="utf-8", newline=None) as text_file:
            for line_no, line in enumerate(text_file, start=1):
                last_line = line_no
                if line_no < offset:
                    if line_no % 1000 == 0 and (cancelled := _cancelled("read_file", _cancellation_token)):
                        return cancelled
                    continue
                if line_no > end_line:
                    has_more = True
                    break
                raw_line = line.rstrip("\r\n")
                clipped = _clip_text(raw_line)
                if len(clipped) < len(raw_line):
                    line_truncated = True
                line_bytes = len(f"{line_no:4d} | {clipped}\n".encode("utf-8"))
                if selected and output_bytes + line_bytes > _READ_MAX_BYTES:
                    has_more = True
                    break
                selected.append((line_no, clipped))
                output_bytes += line_bytes
                if line_no % 1000 == 0 and (cancelled := _cancelled("read_file", _cancellation_token)):
                    return cancelled

        if offset > last_line and not (offset == 1 and last_line == 0):
            return tool_error(
                "read_file",
                f"起始行 {offset} 超出文件总行数 ({last_line} 行)。",
                "OffsetOutOfRange",
                meta={"path": str(file_path), "offset": offset},
            )

        shown_end = selected[-1][0] if selected else 0
        output = [f"Showing lines {offset} to {shown_end}:"]
        output.extend(f"{line_no:4d} | {text}" for line_no, text in selected)
        return tool_ok(
            "read_file",
            "\n".join(output),
            meta={
                "path": str(file_path),
                "offset": offset,
                "limit": effective_limit,
                "truncated": has_more or line_truncated,
                "line_truncated": line_truncated,
                "next_offset": shown_end + 1 if has_more else None,
                "encoding": "utf-8",
                "sha256": digest.hexdigest(),
            },
        )
    except PermissionError:
        return tool_error("read_file", f"无权读取文件: {path}", "PermissionDenied")
    except UnicodeDecodeError:
        return tool_error("read_file", f"文件不是有效的 UTF-8 文本: {path}", "InvalidEncoding")
    except OSError as exc:
        return tool_error("read_file", f"读取文件失败: {exc}", "ReadError")

def glob(
    pattern: str,
    path: str = ".",
    max_results: int = 1000,
    _cancellation_token: CancellationToken | None = None,
) -> str:
    if cancelled := _cancelled("glob", _cancellation_token):
        return cancelled
    search_path, error = _existing_path("glob", path)
    if error:
        return error
    if not search_path.is_dir():
        return tool_error("glob", f"路径不是目录: {path}", "NotADirectory")
    if not isinstance(pattern, str) or not pattern:
        return tool_error("glob", "pattern 不能为空。", "InvalidPattern")
    try:
        max_results = int(max_results)
    except (TypeError, ValueError, OverflowError):
        return tool_error("glob", "max_results 必须是整数。", "InvalidMaxResults")
    if max_results < 1:
        return tool_error("glob", "max_results 必须 >= 1。", "InvalidMaxResults")

    try:
        results: list[dict[str, object]] = []
        truncated = False
        for index, file_path in enumerate(sorted(search_path.rglob(pattern), key=lambda item: item.as_posix().lower())):
            if index % 200 == 0 and (cancelled := _cancelled("glob", _cancellation_token)):
                return cancelled
            if not file_path.is_file() or _is_skipped_path(file_path):
                continue
            if len(results) >= max_results:
                truncated = True
                break
            try:
                size_bytes = file_path.stat().st_size
            except PermissionError:
                return tool_error("glob", f"无权访问文件: {file_path}", "PermissionDenied")
            results.append({"path": _relative_path(file_path, search_path), "size_bytes": int(size_bytes)})

        return tool_ok(
            "glob",
            results,
            meta={
                "path": str(search_path),
                "pattern": pattern,
                "count": len(results),
                "max_results": max_results,
                "truncated": truncated,
            },
        )
    except ValueError as exc:
        return tool_error("glob", f"无效的 glob 模式: {exc}", "InvalidPattern")
    except PermissionError:
        return tool_error("glob", f"无权读取目录: {path}", "PermissionDenied")
    except OSError as exc:
        return tool_error("glob", f"查找文件失败: {exc}", "GlobError")


def _rg_command(rg: str, pattern: str, search_path: Path, file_glob: str) -> list[str]:
    command = [rg, "--json", "--color", "never", "--glob", file_glob]
    for skipped in _SKIP_DIRS:
        command.extend(("--glob", f"!**/{skipped}/**"))
    command.extend(("--", pattern, str(search_path)))
    return command


def _rg_result_path(raw_path: str, search_path: Path) -> str:
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        base = search_path if search_path.is_dir() else search_path.parent
        candidate = base / candidate
    return _relative_path(candidate, search_path)


def _rg_error(stderr: str) -> str:
    lowered = stderr.lower()
    if "permission" in lowered or "access is denied" in lowered:
        return "PermissionDenied"
    if "regex" in lowered or "pattern" in lowered:
        return "InvalidPattern"
    return "GrepError"


def grep(
    pattern: str,
    path: str = ".",
    glob: str = "**/*",
    max_results: int = 1000,
    _cancellation_token: CancellationToken | None = None,
) -> str:
    if cancelled := _cancelled("grep", _cancellation_token):
        return cancelled
    search_path, error = _existing_path("grep", path)
    if error:
        return error
    if not isinstance(pattern, str) or not pattern:
        return tool_error("grep", "pattern 不能为空。", "InvalidPattern")
    if not isinstance(glob, str) or not glob:
        return tool_error("grep", "glob 不能为空。", "InvalidPattern")
    try:
        max_results = int(max_results)
    except (TypeError, ValueError, OverflowError):
        return tool_error("grep", "max_results 必须是整数。", "InvalidMaxResults")
    if max_results < 1:
        return tool_error("grep", "max_results 必须 >= 1。", "InvalidMaxResults")

    rg = shutil.which("rg")
    if not rg:
        return tool_error("grep", "未找到 rg 可执行文件。", "RgUnavailable")

    process: subprocess.Popen[str] | None = None
    results: list[dict[str, object]] = []
    truncated = False
    try:
        process = subprocess.Popen(
            _rg_command(rg, pattern, search_path, glob),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            if cancelled := _cancelled("grep", _cancellation_token):
                process.kill()
                process.wait()
                return cancelled
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "match":
                continue
            if len(results) >= max_results:
                truncated = True
                process.terminate()
                break
            data = event.get("data") or {}
            path_data = data.get("path") or {}
            raw_path = path_data.get("text") or ""
            line_data = data.get("lines") or {}
            results.append(
                {
                    "file": _rg_result_path(raw_path, search_path),
                    "line": int(data.get("line_number") or 0),
                    "text": _clip_text(str(line_data.get("text") or "").rstrip("\r\n")),
                }
            )

        stderr = process.stderr.read() if process.stderr is not None else ""
        return_code = process.wait()
        if return_code not in (0, 1) and not truncated:
            return tool_error("grep", stderr.strip() or "rg 搜索失败。", _rg_error(stderr))
        return tool_ok(
            "grep",
            results,
            meta={
                "pattern": pattern,
                "path": str(search_path),
                "glob": glob,
                "count": len(results),
                "max_results": max_results,
                "truncated": truncated,
            },
        )
    except FileNotFoundError:
        return tool_error("grep", "未找到 rg 可执行文件。", "RgUnavailable")
    except OSError as exc:
        return tool_error("grep", f"无法启动 rg: {exc}", "GrepError")
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
