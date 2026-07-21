import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.rind_docs import (
    RIND_DOC_BYTE_LIMIT,
    build_rind_doc_context,
    resolve_project_doc_path,
    resolve_user_doc_path,
)


def _project_root(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    (root / ".git").mkdir()
    return root


def test_rind_docs_inject_user_before_project(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    project = _project_root(tmp_path)
    user_home.mkdir()
    monkeypatch.setenv("RIND_HOME", str(user_home))
    monkeypatch.chdir(project)
    (user_home / "RIND.md").write_text("user guidance", encoding="utf-8")
    (project / "RIND.md").write_text("project guidance", encoding="utf-8")

    messages, stats, decisions = build_rind_doc_context()
    content = messages[0]["content"]

    assert content.index("--- user-doc ---") < content.index("--- project-doc ---")
    assert "user guidance" in content
    assert "project guidance" in content
    assert stats["rind_docs_user_exists"] is True
    assert stats["rind_docs_project_exists"] is True
    assert decisions["rind_docs_injected"] is True
    assert decisions["rind_docs_truncated"] is False


def test_rind_docs_skip_missing_levels(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    project = _project_root(tmp_path)
    user_home.mkdir()
    monkeypatch.setenv("RIND_HOME", str(user_home))
    monkeypatch.chdir(project)
    (project / "RIND.md").write_text("project only", encoding="utf-8")

    messages, stats, decisions = build_rind_doc_context()
    content = messages[0]["content"]

    assert "--- user-doc ---" not in content
    assert content.startswith("\n\n--- project-doc ---\n\n")
    assert "project only" in content
    assert stats["rind_docs_user_exists"] is False
    assert decisions["rind_docs_injected"] is True


def test_rind_docs_do_not_inject_when_absent(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    project = _project_root(tmp_path)
    user_home.mkdir()
    monkeypatch.setenv("RIND_HOME", str(user_home))
    monkeypatch.chdir(project)

    messages, stats, decisions = build_rind_doc_context()

    assert messages == []
    assert stats["rind_docs_user_exists"] is False
    assert stats["rind_docs_project_exists"] is False
    assert decisions["rind_docs_injected"] is False


def test_rind_docs_truncate_by_utf8_bytes(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    project = _project_root(tmp_path)
    user_home.mkdir()
    monkeypatch.setenv("RIND_HOME", str(user_home))
    monkeypatch.chdir(project)
    raw = b"a" * (RIND_DOC_BYTE_LIMIT - 1) + "你".encode("utf-8")
    (user_home / "RIND.md").write_bytes(raw)

    messages, stats, decisions = build_rind_doc_context()
    content = messages[0]["content"]

    assert "was truncated before injection" in content
    assert "\ufffd" not in content
    assert stats["rind_docs_user_bytes"] == len(raw)
    assert stats["rind_docs_user_injected_bytes"] <= RIND_DOC_BYTE_LIMIT
    assert decisions["rind_docs_truncated"] is True
    assert decisions["rind_docs_truncated_scopes"] == ["user"]


def test_rind_doc_paths_use_configured_home_and_project_root(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    project = _project_root(tmp_path)
    nested = project / "src" / "pkg"
    nested.mkdir(parents=True)
    monkeypatch.setenv("RIND_HOME", str(user_home))
    monkeypatch.chdir(nested)

    assert resolve_user_doc_path() == user_home.resolve() / "RIND.md"
    assert resolve_project_doc_path() == nested.resolve() / "RIND.md"


def test_rind_project_doc_uses_cwd_not_parent_git_root(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    project = _project_root(tmp_path)
    nested = project / "src"
    nested.mkdir()
    monkeypatch.setenv("RIND_HOME", str(user_home))
    monkeypatch.chdir(nested)
    (project / "RIND.md").write_text("parent git root doc", encoding="utf-8")
    (nested / "RIND.md").write_text("cwd doc", encoding="utf-8")

    messages, _, decisions = build_rind_doc_context()

    assert "cwd doc" in messages[0]["content"]
    assert "parent git root doc" not in messages[0]["content"]
    assert decisions["rind_docs_project_path"] == str(nested.resolve() / "RIND.md")
