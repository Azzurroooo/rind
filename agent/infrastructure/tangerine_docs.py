"""TANGERINE.md context document loading."""

from __future__ import annotations

from pathlib import Path

from agent.infrastructure.paths import resolve_tangerine_home, resolve_project_root


TANGERINE_DOC_NAME = "TANGERINE.md"
TANGERINE_DOC_BYTE_LIMIT = 32 * 1024


def resolve_user_doc_path() -> Path:
    return resolve_tangerine_home() / TANGERINE_DOC_NAME


def resolve_project_doc_path(cwd: Path | None = None) -> Path:
    return resolve_project_root(cwd) / TANGERINE_DOC_NAME


def build_tangerine_doc_context(cwd: Path | None = None) -> tuple[list[dict], dict, dict]:
    docs = [
        _read_doc("user", resolve_user_doc_path()),
        _read_doc("project", resolve_project_doc_path(cwd)),
    ]
    injected_docs = [doc for doc in docs if doc["exists"] and not doc["error_type"]]
    stats = _build_stats(docs, injected_docs)
    decisions = _build_decisions(docs, injected_docs)
    if not injected_docs:
        return [], stats, decisions

    content = "".join(_render_doc(doc) for doc in injected_docs)
    return [
        {
            "role": "system",
            "content": content,
            "_context_kind": "tangerine_docs",
        }
    ], stats, decisions


def _read_doc(scope: str, path: Path) -> dict:
    doc = {
        "scope": scope,
        "path": str(path),
        "exists": path.is_file(),
        "raw_bytes": 0,
        "injected_bytes": 0,
        "truncated": False,
        "content": "",
        "error_type": None,
    }
    if not doc["exists"]:
        return doc
    try:
        raw = path.read_bytes()
    except Exception as exc:
        doc["error_type"] = type(exc).__name__
        return doc

    raw_bytes = len(raw)
    truncated = raw_bytes > TANGERINE_DOC_BYTE_LIMIT
    clipped = raw[:TANGERINE_DOC_BYTE_LIMIT] if truncated else raw
    text = clipped.decode("utf-8", errors="ignore" if truncated else "replace")
    doc.update(
        {
            "raw_bytes": raw_bytes,
            "injected_bytes": len(text.encode("utf-8")),
            "truncated": truncated,
            "content": text,
        }
    )
    return doc


def _render_doc(doc: dict) -> str:
    warning = ""
    if doc["truncated"]:
        warning = (
            f"[warning] {doc['scope']} TANGERINE.md exceeded "
            f"{TANGERINE_DOC_BYTE_LIMIT} bytes and was truncated before injection.\n\n"
        )
    return f"\n\n--- {doc['scope']}-doc ---\n\n{warning}{doc['content']}"


def _build_stats(docs: list[dict], injected_docs: list[dict]) -> dict:
    by_scope = {doc["scope"]: doc for doc in docs}
    return {
        "tangerine_docs_user_exists": bool(by_scope["user"]["exists"]),
        "tangerine_docs_project_exists": bool(by_scope["project"]["exists"]),
        "tangerine_docs_user_bytes": int(by_scope["user"]["raw_bytes"]),
        "tangerine_docs_project_bytes": int(by_scope["project"]["raw_bytes"]),
        "tangerine_docs_user_injected_bytes": int(by_scope["user"]["injected_bytes"]),
        "tangerine_docs_project_injected_bytes": int(by_scope["project"]["injected_bytes"]),
        "tangerine_docs_injected_chars": sum(len(doc["content"]) for doc in injected_docs),
    }


def _build_decisions(docs: list[dict], injected_docs: list[dict]) -> dict:
    truncated_scopes = [str(doc["scope"]) for doc in docs if doc["truncated"]]
    error_type = next((doc["error_type"] for doc in docs if doc["error_type"]), None)
    by_scope = {doc["scope"]: doc for doc in docs}
    return {
        "tangerine_docs_injected": bool(injected_docs),
        "tangerine_docs_truncated": bool(truncated_scopes),
        "tangerine_docs_truncated_scopes": truncated_scopes,
        "tangerine_docs_user_path": by_scope["user"]["path"],
        "tangerine_docs_project_path": by_scope["project"]["path"],
        "tangerine_docs_error_type": error_type,
    }
