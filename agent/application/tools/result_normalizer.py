"""Deterministic model-facing rendering for tool results."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any


_PREFERRED_KEYS = (
    "ok",
    "tool",
    "data",
    "error",
    "error_type",
    "meta",
    "ts",
)


@dataclass(slots=True)
class NormalizedToolResult:
    """Fixed model-facing content for a persisted tool result."""

    model_content: str
    model_content_format: str = "tool_result_v1"
    model_content_policy: dict[str, Any] = field(default_factory=dict)
    artifact_ref: str | None = None


class ToolResultNormalizer:
    """Normalize a raw tool payload once, at tool execution time."""

    policy_version = "tool_result_v1"

    def __init__(self, max_tokens: int = 10000, max_chars: int = 40000):
        self.max_tokens = max(1, int(max_tokens))
        self.max_chars = max(1, int(max_chars))
        self._tokenizer = self._get_tokenizer()
        self._cjk_pattern = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

    def normalize(self, result_payload: Any) -> NormalizedToolResult:
        rendered = self._render_stable(result_payload)
        original_chars = len(rendered)
        estimated_tokens = self._estimate_tokens(rendered)
        effective_max_chars = min(self.max_chars, self.max_tokens * 4)
        truncated = original_chars > effective_max_chars or estimated_tokens > self.max_tokens
        model_content = rendered
        if truncated:
            model_content = self._truncate(rendered, effective_max_chars, original_chars)

        policy = {
            "version": self.policy_version,
            "max_tokens": self.max_tokens,
            "max_chars": self.max_chars,
            "effective_max_chars": effective_max_chars,
            "truncated": truncated,
            "original_chars": original_chars,
            "model_chars": len(model_content),
            "estimated_original_tokens": estimated_tokens,
        }
        return NormalizedToolResult(
            model_content=model_content,
            model_content_policy=policy,
        )

    def _render_stable(self, payload: Any) -> str:
        parsed = self._parse_json(payload)
        if isinstance(parsed, str):
            return parsed
        parsed = self._compress_empty_bash_output_poll(parsed)
        canonical = self._canonicalize(parsed)
        return json.dumps(canonical, ensure_ascii=False, separators=(",", ": "))

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
        return {
            "ok": True,
            "tool": "bash_output",
            "data": compact_data,
        }

    def _parse_json(self, payload: Any) -> Any:
        if not isinstance(payload, str):
            return payload
        text = payload.strip()
        if not text:
            return ""
        try:
            return json.loads(text)
        except Exception:
            return payload

    def _canonicalize(self, value: Any) -> Any:
        if isinstance(value, dict):
            ordered: dict[str, Any] = {}
            for key in _PREFERRED_KEYS:
                if key in value:
                    ordered[key] = self._canonicalize(value[key])
            for key in sorted((key for key in value.keys() if key not in ordered), key=str):
                ordered[key] = self._canonicalize(value[key])
            return ordered
        if isinstance(value, list):
            return [self._canonicalize(item) for item in value]
        return value

    def _truncate(self, text: str, limit: int, original_chars: int) -> str:
        marker = (
            "\n\n[tool_result_truncated: "
            f"original_chars={original_chars}, max_chars={limit}]"
            "\n\n"
        )
        if limit <= len(marker) + 2:
            return marker.strip()
        available = max(1, limit - len(marker))
        head_chars = max(1, available // 2)
        tail_chars = max(1, available - head_chars)
        return text[:head_chars].rstrip() + marker + text[-tail_chars:].lstrip()

    def _estimate_tokens(self, text: str) -> int:
        if self._tokenizer:
            try:
                return len(self._tokenizer.encode(text, disallowed_special=()))
            except Exception:
                pass
        divisor = 1.5 if self._cjk_pattern.search(text) else 3.5
        return int(math.ceil(len(text) / divisor))

    def _get_tokenizer(self):
        try:
            import tiktoken

            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None
