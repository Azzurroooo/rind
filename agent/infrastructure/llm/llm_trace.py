"""TEMPORARY raw LLM trace for debugging (e.g. lost tool calls).

Records every chat-completions exchange — the full request payload and each raw
response chunk — BEFORE the response is handed back to the runtime, so the trace
reflects exactly what the provider sent over the wire.

Gated by env var ``RIND_TRACE_LLM`` (default off). When enabled, each call writes
one JSONL file under ``<rind_home>/sessions/<session_id>/_llm_trace/``. Each line
is one record:

    {"direction": "request",  "ts": ..., "model": ..., "messages": [...], "tools": [...], ...}
    {"direction": "response", "ts": ..., "chunk": <serialized provider chunk>}
    ...
    {"direction": "end",      "ts": ..., "reason": "completed|cancelled|error", "error"?: ...}

Lines are flushed after every write so partial data survives a crash.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from agent.infrastructure.paths import resolve_rind_home

_ENV_FLAG = "RIND_TRACE_LLM"
_SUBDIR = "_llm_trace"
_TRUTHY = {"1", "true", "yes", "on"}


def trace_enabled() -> bool:
    return os.getenv(_ENV_FLAG, "").strip().lower() in _TRUTHY


def resolve_trace_dir(session_id: str | None) -> Path | None:
    sid = (session_id or "").strip()
    if not trace_enabled() or not sid:
        return None
    trace_dir = resolve_rind_home() / "sessions" / sid / _SUBDIR
    trace_dir.mkdir(parents=True, exist_ok=True)
    return trace_dir


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_serialize(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _serialize(item) for key, item in value.items()}
    for attr in ("model_dump", "to_dict", "as_dict", "dict"):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                return _serialize(fn())
            except Exception:
                continue
    public = getattr(value, "__dict__", None)
    if isinstance(public, dict) and public:
        return _serialize(public)
    return repr(value)


class LlmCallTrace:
    """One JSONL file per chat-completions call."""

    def __init__(self, trace_dir: Path, *, label: str = "stream") -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        self.path = trace_dir / f"{stamp}_{label}_{uuid.uuid4().hex[:8]}.jsonl"
        self._fh: Any = None

    def _emit(self, record: dict[str, Any]) -> None:
        if self._fh is None:
            self._fh = self.path.open("a", encoding="utf-8")
        self._fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        self._fh.flush()

    def request(self, payload: dict[str, Any]) -> None:
        self._emit({"direction": "request", "ts": _now(), **payload})

    def response_chunk(self, chunk: Any) -> None:
        self._emit({"direction": "response", "ts": _now(), "chunk": _serialize(chunk)})

    def response(self, value: Any) -> None:
        self._emit({"direction": "response", "ts": _now(), "value": _serialize(value)})

    def end(self, reason: str, error: str | None = None) -> None:
        record: dict[str, Any] = {"direction": "end", "ts": _now(), "reason": reason}
        if error:
            record["error"] = error
        self._emit(record)
        self.close()

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None


def make_trace(
    session_id_provider: Callable[[], str] | None,
    *,
    label: str,
) -> LlmCallTrace | None:
    """Build a trace for the current call, or None when tracing is off/unavailable."""
    if session_id_provider is None:
        return None
    try:
        session_id = session_id_provider()
    except Exception:
        return None
    trace_dir = resolve_trace_dir(session_id)
    if trace_dir is None:
        return None
    try:
        return LlmCallTrace(trace_dir, label=label)
    except Exception:
        return None
