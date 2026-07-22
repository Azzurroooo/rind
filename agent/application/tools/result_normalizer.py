"""Deterministic bounded projections for tool results."""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable


logger = logging.getLogger(__name__)


_PREFERRED_KEYS = (
    "ok",
    "tool",
    "data",
    "error",
    "error_type",
    "meta",
    "ts",
)
_TRUNCATION_MARKER = (
    "\n\n[tool_result_truncated: rerun with narrower parameters or redirect output "
    "to a chosen file]\n\n"
)


@dataclass(slots=True)
class NormalizedToolResult:
    terminal_content: str
    model_content: str
    persisted_content: str
    model_content_format: str = "tool_result_v2"
    model_content_policy: dict[str, Any] = field(default_factory=dict)


class ToolResultNormalizer:
    """Render one tool result into bounded terminal, model, and disk projections."""

    format_version = "tool_result_v2"

    def __init__(
        self,
        max_tokens: int = 10000,
        max_chars: int = 40000,
        terminal_max_bytes: int = 8 * 1024,
        persistence_max_bytes: int = 64 * 1024,
    ):
        self.max_tokens = max(1, int(max_tokens))
        self.max_chars = max(1, int(max_chars))
        self.terminal_max_bytes = max(1, int(terminal_max_bytes))
        self.persistence_max_bytes = max(1, int(persistence_max_bytes))
        self._tokenizer = self._get_tokenizer()
        self._cjk_pattern = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

    def normalize(
        self,
        result_payload: Any,
        *,
        tool_name: str = "",
        status: str = "completed",
        error_type: str = "",
    ) -> NormalizedToolResult:
        rendered = self._render_stable(result_payload)
        total_bytes, total_lines = self._text_metrics(rendered)
        identity = self._projection_identity(rendered, tool_name, status, error_type)

        terminal_content = self._project_by_bytes(
            rendered,
            self.terminal_max_bytes,
            total_bytes,
            total_lines,
            identity,
        )
        persisted_content = self._project_by_bytes(
            rendered,
            self.persistence_max_bytes,
            total_bytes,
            total_lines,
            identity,
        )
        model_content = self._project_for_model(
            rendered,
            total_bytes,
            total_lines,
            identity,
        )
        model_truncated = model_content != rendered
        policy: dict[str, Any] = {"truncated": model_truncated}
        if model_truncated:
            policy.update({"total_bytes": total_bytes, "total_lines": total_lines})

        return NormalizedToolResult(
            terminal_content=terminal_content,
            model_content=model_content,
            persisted_content=persisted_content,
            model_content_policy=policy,
        )

    def _render_stable(self, payload: Any) -> str:
        if isinstance(payload, str) and len(payload) > self.persistence_max_bytes:
            return payload
        parsed = self._parse_json(payload)
        if isinstance(parsed, str):
            return parsed
        parsed = self._compress_empty_bash_output_poll(parsed)
        canonical = self._canonicalize(parsed)
        return json.dumps(canonical, ensure_ascii=False, separators=(",", ": "))

    def _project_by_bytes(
        self,
        text: str,
        limit: int,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
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
        )

    def _project_for_model(
        self,
        text: str,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
    ) -> str:
        if len(text) <= self.max_chars and self._estimate_tokens(text) <= self.max_tokens:
            return text
        return self._bounded_projection(
            text,
            total_bytes,
            total_lines,
            identity,
            min(len(text), self.max_chars),
            lambda candidate: (
                len(candidate) <= self.max_chars
                and self._estimate_tokens(candidate) <= self.max_tokens
            ),
        )

    def _bounded_projection(
        self,
        text: str,
        total_bytes: int,
        total_lines: int,
        identity: tuple[bool, str, str],
        max_preview_chars: int,
        fits: Callable[[str], bool],
    ) -> str:
        low = 0
        high = max_preview_chars
        best = self._serialize_projection("", total_bytes, total_lines, identity)
        while low <= high:
            preview_chars = (low + high) // 2
            candidate = self._serialize_projection(
                self._preview(text, preview_chars),
                total_bytes,
                total_lines,
                identity,
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
    ) -> str:
        ok, tool_name, error_type = identity
        payload: dict[str, Any] = {"ok": ok, "tool": tool_name}
        if ok:
            payload["data"] = preview
        else:
            payload["error"] = preview
            if error_type:
                payload["error_type"] = error_type
        payload["meta"] = {
            "truncated": True,
            "total_bytes": total_bytes,
            "total_lines": total_lines,
        }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ": "))

    def _projection_identity(
        self,
        rendered: str,
        tool_name: str,
        status: str,
        error_type: str,
    ) -> tuple[bool, str, str]:
        parsed = self._parse_json(rendered) if len(rendered) <= self.persistence_max_bytes else None
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
        if limit <= len(_TRUNCATION_MARKER):
            return _TRUNCATION_MARKER[:limit]
        available = limit - len(_TRUNCATION_MARKER)
        head_chars = available // 2
        tail_chars = available - head_chars
        return text[:head_chars].rstrip() + _TRUNCATION_MARKER + text[-tail_chars:].lstrip()

    def _text_metrics(self, text: str) -> tuple[int, int]:
        chunk_chars = 1024 * 1024
        total_bytes = sum(
            len(text[offset : offset + chunk_chars].encode("utf-8"))
            for offset in range(0, len(text), chunk_chars)
        )
        total_lines = text.count("\n") + int(bool(text) and not text.endswith("\n"))
        return total_bytes, total_lines

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
        return {"ok": True, "tool": "bash_output", "data": compact_data}

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

    def _estimate_tokens(self, text: str) -> int:
        if self._tokenizer:
            try:
                return len(self._tokenizer.encode(text, disallowed_special=()))
            except Exception:
                logger.debug("Tokenizer failed; using heuristic tool-result estimate.", exc_info=True)
        divisor = 1.5 if self._cjk_pattern.search(text) else 3.5
        return int(math.ceil(len(text) / divisor))

    def _get_tokenizer(self):
        try:
            import tiktoken

            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None
