"""Repository for persisting and loading tool calls."""

from __future__ import annotations

import json
from typing import Any
from agent.infrastructure.persistence.session_files import SessionFiles

class ToolCallRepository:
    def __init__(self, files: SessionFiles, path: str, looks_like_tool_payload=None):
        self._files = files
        self._path = path
        self._looks_like_tool_payload = looks_like_tool_payload

    def persist_tool_call(
        self,
        call_id: str,
        name: str,
        args: dict,
        raw_args: str,
        ts_start: str,
        ts_end: str,
        result: str,
        model_content: str,
        model_content_format: str | None = None,
        model_content_policy: dict[str, Any] | None = None,
        artifact_ref: str | None = None,
    ) -> None:
        if not isinstance(model_content, str) or not model_content:
            raise ValueError("tool record schema v2 requires non-empty model_content")
        parsed = self._parse_tool_result(result)
        ok = None
        error_type = None
        error_message = None
        meta = None
        if isinstance(parsed, dict) and "ok" in parsed and "tool" in parsed:
            ok = bool(parsed.get("ok"))
            error_type = parsed.get("error_type")
            error_message = parsed.get("error")
            meta = self._extract_tool_meta(parsed)
        record = {
            "id": call_id,
            "ts_start": ts_start,
            "ts_end": ts_end,
            "name": name,
            "args": args,
            "raw_args": raw_args,
            "result": parsed,
            "ok": ok,
            "error_type": error_type,
            "error_message": error_message,
            "meta": meta,
            "model_content": model_content,
            "model_content_format": model_content_format or "tool_result_v1",
            "model_content_policy": dict(model_content_policy or {}),
            "artifact_ref": artifact_ref,
        }
        self._files.append_jsonl(self._path, record)

    def load_tool_calls(self) -> list[dict[str, Any]]:
        return self._files.read_jsonl(self._path)

    def _parse_tool_result(self, result: str):
        if isinstance(result, str) and self._looks_like_tool_payload and self._looks_like_tool_payload(result):
            try:
                return json.loads(result)
            except Exception:
                return result
        return result

    def _extract_tool_meta(self, payload):
        if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
            data = payload.get("data")
            meta = {}
            if isinstance(data.get("stdout"), str):
                meta["stdout_size"] = len(data.get("stdout"))
            if isinstance(data.get("stderr"), str):
                meta["stderr_size"] = len(data.get("stderr"))
            if "exit_code" in data:
                meta["exit_code"] = data.get("exit_code")
            if meta:
                return meta
        return None
