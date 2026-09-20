"""Deterministic bounded projections for tool results."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol


_PREFERRED_KEYS = (
    "ok",
    "tool",
    "data",
    "error",
    "error_type",
    "meta",
    "ts",
)
_MAX_PREVIEW_BYTES = 25 * 1024
_MAX_PREVIEW_LINES = 2_000
_TRUNCATION_MARKER = "\n\nOutput truncated. Full output is available at {output_path}.\nUse read_file or bash to inspect it.\n"
_READ_PAGE_MARKER = "\n\nRead output is limited to the requested page. Use the original path and next_offset in meta to continue reading.\n"
_READ_PREVIEW_MARKER = "\n\nRead preview is incomplete. Read the original path in smaller ranges.\n"


class ToolOutputWriter(Protocol):
    async def write(self, session_id: str, call_id: str, content: str) -> str:
        ...


@dataclass(slots=True)
class NormalizedToolResult:
    terminal_content: str
    model_content: str
    model_content_format: str = "tool_result_v2"
    model_content_policy: dict[str, Any] = field(default_factory=dict)


class ToolResultNormalizer:
    """Render one tool result into bounded terminal, model, and disk projections."""

    def __init__(
        self,
        terminal_max_bytes: int = 8 * 1024,
        max_preview_bytes: int = _MAX_PREVIEW_BYTES,
        max_preview_lines: int = _MAX_PREVIEW_LINES,
    ):
        self.terminal_max_bytes = max(1, int(terminal_max_bytes))
        self.max_preview_bytes = max(1, int(max_preview_bytes))
        self.max_preview_lines = max(1, int(max_preview_lines))

    async def normalize(
        self,
        result_payload: Any,
        *,
        tool_name: str = "",
        status: str = "completed",
        error_type: str = "",
        output_store: ToolOutputWriter | None = None,
        session_id: str = "",
        call_id: str = "",
    ) -> NormalizedToolResult:
        payload = self._canonicalize(self._compress_empty_bash_output_poll(self._parse_json(result_payload)))
        rendered = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, separators=(",", ": "))
        if isinstance(payload, str):
            payload = self._parse_json(payload)
        total_bytes, total_lines = self._text_metrics(rendered)
        identity = self._projection_identity(payload, tool_name, status, error_type)
        existing_path, existing_truncated = self._existing_output_reference(payload)
        is_read = identity[1] == "read_file"
        is_mutation = identity[0] and identity[1] in {"edit_file", "write_file"}
        preview_required = total_bytes > self.max_preview_bytes or total_lines > self.max_preview_lines
        needs_preview = preview_required or existing_truncated
        output_path = existing_path
        if needs_preview and not is_read and not is_mutation and not output_path and output_store is not None and session_id and call_id:
            output_path = await output_store.write(session_id, call_id, rendered)
        read_payload = self._read_payload(payload) if is_read else None
        source_metadata = dict(read_payload["meta"]) if read_payload is not None else None

        terminal_content = self._project_by_bytes(
            rendered,
            self.terminal_max_bytes,
            total_bytes,
            total_lines,
            identity,
            output_path=None,
            include_notice=False,
            metadata=source_metadata,
        )
        if read_payload is not None:
            model_content = self._project_read_for_model(read_payload)
            if json.loads(model_content).get("ok") is False:
                terminal_content = model_content
        elif is_mutation and isinstance(payload, dict):
            model_content = self._project_mutation_for_model(payload)
        elif needs_preview:
            model_content = self._project_for_model(
                rendered, total_bytes, total_lines, identity, output_path,
                truncation_marker=_READ_PREVIEW_MARKER if is_read else _TRUNCATION_MARKER,
            )
        else:
            model_content = rendered

        return NormalizedToolResult(
            terminal_content=terminal_content,
            model_content=model_content,
            model_content_policy={"truncated": model_content != rendered},
        )

    def _project_by_bytes(
        self,
        text: str,
        limit: int,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
        *,
        output_path: str | None,
        include_notice: bool,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        if total_bytes <= limit:
            return text
        return self._bounded_projection(
            text,
            total_bytes,
            total_lines,
            identity,
            min(len(text), limit),
            lambda candidate: len(candidate.encode("utf-8")) <= limit,
            output_path=output_path,
            include_notice=include_notice,
            metadata=metadata,
        )

    def _project_for_model(
        self,
        text: str,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
        output_path: str | None,
        truncation_marker: str = _TRUNCATION_MARKER,
    ) -> str:
        return self._bounded_projection(
            text,
            total_bytes,
            total_lines,
            identity,
            min(len(text), self.max_preview_bytes),
            lambda candidate: (
                len(candidate.encode("utf-8")) <= self.max_preview_bytes
                and self._line_count(candidate) <= self.max_preview_lines
            ),
            output_path=output_path,
            include_notice=True,
            truncation_marker=truncation_marker,
        )

    def _project_read_for_model(self, payload: dict) -> str:
        meta = dict(payload.get("meta") or {})
        meta.pop("output_path", None)
        offset = int(meta.get("offset", 1))
        header, *body = payload["data"].split("\n")
        matched = re.fullmatch(rf"Showing lines {offset} to (\d+):", header)
        if matched is None:
            return json.dumps({"ok": False, "tool": "read_file", "error_type": "InvalidReadResult",
                               "error": "Read result has no valid consecutive line range. Read the original path again.",
                               "meta": {"path": meta.get("path"), "offset": offset}}, ensure_ascii=False)
        lines = []
        for line in body:
            if not re.match(rf"\s*{offset + len(lines)} \|", line):
                break
            lines.append(line)
        incomplete = offset + len(lines) - 1 < int(matched[1])
        if meta.get("line_truncated"):
            lines = lines[:next((i for i, line in enumerate(lines) if re.search(r"\.\.\.\(truncated:\d+\)$", line)), 0)]

        def serialize(count: int) -> str:
            projected = dict(payload)
            next_offset = offset + count if count < len(lines) or incomplete or meta.get("line_truncated") else meta.get("next_offset")
            projected["data"] = "\n".join([f"Showing lines {offset} to {offset + count - 1 if count else 0}:", *lines[:count]])
            if next_offset is not None:
                projected["data"] += _READ_PAGE_MARKER
            projected["meta"] = {**meta, "limit": count, "next_offset": next_offset, "truncated": next_offset is not None, "line_truncated": False}
            return json.dumps(projected, ensure_ascii=False, separators=(",", ": "))

        low = 0
        high = len(lines)
        best_count = 0
        while low <= high:
            count = (low + high) // 2
            candidate = serialize(count)
            if len(candidate.encode("utf-8")) <= self.max_preview_bytes and count + 1 <= self.max_preview_lines:
                best_count = count
                low = count + 1
            else:
                high = count - 1
        if not best_count and (lines or incomplete or meta.get("line_truncated")):
            return json.dumps({
                "ok": False, "tool": "read_file", "error_type": "LineTooLong",
                "error": f"Line {offset} was not displayed in full. Use bash/Python to read it in character slices (splitlines()[{offset - 1}][start:end]), then resume at offset {offset + 1}.",
                "meta": {"path": meta.get("path"), "offset": offset},
            }, ensure_ascii=False)
        return serialize(best_count)

    def _project_mutation_for_model(self, payload: dict) -> str:
        projected = dict(payload)
        meta = dict(payload.get("meta") or {})
        files = []
        for item in meta.get("files", []):
            entry = {key: value for key, value in item.items() if key != "diff"}
            if payload["tool"] == "edit_file" and item.get("diff"):
                diff = item["diff"]
                preview = "\n".join(diff.splitlines()[:12])[:1200]
                entry["diff"] = preview + ("\n... diff preview truncated ..." if preview != diff else "")
            files.append(entry)
        projected["meta"] = {**meta, "files": files}
        return json.dumps(projected, ensure_ascii=False, separators=(",", ": "))

    def _bounded_projection(
        self,
        text: str,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
        max_preview_chars: int,
        fits,
        *,
        output_path: str | None,
        include_notice: bool,
        metadata: dict[str, Any] | None = None,
        truncation_marker: str = _TRUNCATION_MARKER,
    ) -> str:
        low = 0
        high = max_preview_chars
        best = self._serialize_projection(
            "",
            total_bytes,
            total_lines,
            identity,
            output_path=output_path,
            include_notice=include_notice,
            metadata=metadata,
            truncation_marker=truncation_marker,
        )
        while low <= high:
            preview_chars = (low + high) // 2
            candidate = self._serialize_projection(
                self._preview(text, preview_chars),
                total_bytes,
                total_lines,
                identity,
                output_path=output_path,
                include_notice=include_notice,
                metadata=metadata,
                truncation_marker=truncation_marker,
            )
            if fits(candidate):
                best = candidate
                low = preview_chars + 1
            else:
                high = preview_chars - 1
        return best

    def _serialize_projection(
        self,
        preview: str,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
        *,
        output_path: str | None,
        include_notice: bool,
        metadata: dict[str, Any] | None = None,
        truncation_marker: str = _TRUNCATION_MARKER,
    ) -> str:
        ok, tool_name, error_type = identity
        payload: dict[str, Any] = {"ok": ok, "tool": tool_name}
        value = preview
        if include_notice:
            value += truncation_marker.format(output_path=output_path or "the output file")
        if ok:
            payload["data"] = value
        else:
            payload["error"] = value
            if error_type:
                payload["error_type"] = error_type
        meta: dict[str, Any] = dict(metadata or {})
        meta.update({
            "truncated": True,
            "total_bytes": total_bytes,
            "total_lines": total_lines,
        })
        if output_path:
            meta["output_path"] = output_path
        payload["meta"] = meta
        return json.dumps(payload, ensure_ascii=False, separators=(",", ": "))

    def _existing_output_reference(self, parsed: Any) -> tuple[str | None, bool]:
        if not isinstance(parsed, dict):
            return None, False
        meta = parsed.get("meta")
        if not isinstance(meta, dict):
            return None, False
        output_path = meta.get("output_path")
        return (str(output_path) if isinstance(output_path, str) and output_path else None), bool(meta.get("truncated"))

    def _read_payload(self, parsed: Any) -> dict[str, Any] | None:
        if not isinstance(parsed, dict) or parsed.get("tool") != "read_file":
            return None
        if not isinstance(parsed.get("data"), str) or not isinstance(parsed.get("meta"), dict):
            return None
        return parsed

    def _projection_identity(
        self,
        parsed: Any,
        tool_name: str,
        status: str,
        error_type: str,
    ) -> tuple[bool, str, str]:
        if isinstance(parsed, dict):
            ok = parsed.get("ok") if isinstance(parsed.get("ok"), bool) else status == "completed"
            name = parsed.get("tool") if isinstance(parsed.get("tool"), str) else tool_name
            parsed_error_type = parsed.get("error_type")
            if isinstance(parsed_error_type, str):
                error_type = parsed_error_type
            return ok, name or tool_name, error_type
        return status == "completed", tool_name, error_type

    def _preview(self, text: str, limit: int) -> str:
        if limit <= 0:
            return ""
        marker = "\n\n... preview truncated ...\n\n"
        available = max(1, limit - len(marker))
        head_chars = available // 2
        tail_chars = available - head_chars
        return text[:head_chars].rstrip() + marker + text[-tail_chars:].lstrip()

    def _text_metrics(self, text: str) -> tuple[int, int]:
        return len(text.encode("utf-8")), self._line_count(text)

    @staticmethod
    def _line_count(text: str) -> int:
        return text.count("\n") + int(bool(text) and not text.endswith("\n"))

    def _parse_json(self, payload: Any) -> Any:
        if not isinstance(payload, str):
            return payload
        text = payload.strip()
        if not text:
            return ""
        try:
            return json.loads(text)
        except (TypeError, ValueError):
            return payload

    def _compress_empty_bash_output_poll(self, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        if value.get("ok") is not True or value.get("tool") != "bash_output":
            return value
        data = value.get("data")
        if not isinstance(data, dict):
            return value
        if data.get("status") != "running" or data.get("no_new_output") is not True:
            return value
        if data.get("stdout") or data.get("stderr"):
            return value
        compact_data = {
            "bg_id": data.get("bg_id"),
            "status": data.get("status"),
            "no_new_output": True,
            "empty_observation_count": data.get("empty_observation_count", 0),
            "suggested_next_wait_ms": data.get("suggested_next_wait_ms"),
        }
        if "wait_ms" in data:
            compact_data["wait_ms"] = data.get("wait_ms")
        if "elapsed_ms" in data:
            compact_data["elapsed_ms"] = data.get("elapsed_ms")
        compact = {"ok": True, "tool": "bash_output", "data": compact_data}
        if isinstance(value.get("meta"), dict):
            compact["meta"] = value["meta"]
        return compact

    def _canonicalize(self, value: Any) -> Any:
        if isinstance(value, dict):
            ordered: dict[str, Any] = {}
            for key in _PREFERRED_KEYS:
                if key in value:
                    ordered[key] = self._canonicalize(value[key])
            for key in sorted((key for key in value if key not in ordered), key=str):
                ordered[key] = self._canonicalize(value[key])
            return ordered
        if isinstance(value, list):
            return [self._canonicalize(item) for item in value]
        return value
