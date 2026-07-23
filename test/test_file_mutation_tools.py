"""Strict apply_patch mutation tests."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.tools.executor import ToolExecutor
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin.files import apply_patch
from agent.infrastructure.tools.builtin.files import mutations


def _payload(raw: str) -> dict:
    value = json.loads(raw)
    assert isinstance(value, dict)
    return value


def _ok(raw: str) -> dict:
    value = _payload(raw)
    assert value["ok"] is True, value
    return value


def _error(raw: str, error_type: str) -> dict:
    value = _payload(raw)
    assert value["ok"] is False, value
    assert value["error_type"] == error_type, value
    return value


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _temp_files(directory: Path) -> list[Path]:
    return [path for path in directory.rglob("*.tmp") if path.name.startswith(".")]


def test_apply_patch_adds_nested_and_empty_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    patch = """*** Begin Patch
*** Add File: nested/new.txt
+one
+two
*** Add File: empty.txt
*** End Patch"""

    result = _ok(apply_patch(patch))

    assert (tmp_path / "nested" / "new.txt").read_text(encoding="utf-8") == "one\ntwo\n"
    assert (tmp_path / "empty.txt").read_bytes() == b""
    files = result["meta"]["files"]
    assert [Path(item["path"]).name for item in files] == ["new.txt", "empty.txt"]
    assert [(item["added_lines"], item["removed_lines"]) for item in files] == [(2, 0), (0, 0)]
    assert "+one" in files[0]["diff"]
    assert files[1]["diff"] == ""
    assert not _temp_files(tmp_path)


def test_apply_patch_supports_single_multi_hunk_and_full_rewrite(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    single = tmp_path / "single.txt"
    multiple = tmp_path / "multiple.txt"
    rewrite = tmp_path / "rewrite.txt"
    single.write_text("before\nold\nafter\n", encoding="utf-8")
    multiple.write_text("alpha\none\nmiddle\ntwo\nomega\n", encoding="utf-8")
    rewrite.write_text("old one\nold two\n", encoding="utf-8")
    patch = f"""*** Begin Patch
*** Update File: single.txt
*** Expected SHA256: {_sha(single)}
@@
 before
-old
+new
 after
*** Update File: multiple.txt
*** Expected SHA256: {_sha(multiple)}
@@
 alpha
-one
+ONE
@@
 middle
-two
+TWO
 omega
*** Update File: rewrite.txt
*** Expected SHA256: {_sha(rewrite)}
@@
-old one
-old two
+new one
+new two
+new three
*** End Patch"""

    result = _ok(apply_patch(patch))

    assert single.read_text(encoding="utf-8") == "before\nnew\nafter\n"
    assert multiple.read_text(encoding="utf-8") == "alpha\nONE\nmiddle\nTWO\nomega\n"
    assert rewrite.read_text(encoding="utf-8") == "new one\nnew two\nnew three\n"
    assert [
        (item["added_lines"], item["removed_lines"]) for item in result["meta"]["files"]
    ] == [(1, 1), (2, 2), (3, 2)]


def test_apply_patch_adds_updates_and_deletes_in_one_call(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    update_path = tmp_path / "update.txt"
    delete_path = tmp_path / "delete.txt"
    update_path.write_text("old\n", encoding="utf-8")
    delete_path.write_text("remove me\n", encoding="utf-8")
    patch = f"""*** Begin Patch
*** Add File: added.txt
+created
*** Update File: update.txt
*** Expected SHA256: {_sha(update_path)}
@@
-old
+updated
*** Delete File: delete.txt
*** Expected SHA256: {_sha(delete_path)}
*** End Patch"""

    result = _ok(apply_patch(patch))

    assert (tmp_path / "added.txt").read_text(encoding="utf-8") == "created\n"
    assert update_path.read_text(encoding="utf-8") == "updated\n"
    assert not delete_path.exists()
    files = result["meta"]["files"]
    assert [Path(item["path"]).name for item in files] == ["added.txt", "update.txt", "delete.txt"]
    assert [(item["added_lines"], item["removed_lines"]) for item in files] == [(1, 0), (1, 1), (0, 1)]
    assert all(set(item) == {"path", "added_lines", "removed_lines", "diff"} for item in files)


@pytest.mark.parametrize(
    ("patch", "error_type"),
    [
        ("", "InvalidPatch"),
        ("--- a.txt\n+++ a.txt", "InvalidPatch"),
        ("*** Begin Patch\n*** Move to: b.txt\n*** End Patch", "InvalidPatch"),
        ("*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch", "InvalidPath"),
        (
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch",
            "PreimageRequired",
        ),
        (
            "*** Begin Patch\n*** Update File: a.txt\n*** Expected SHA256: bad\n@@\n-a\n+b\n*** End Patch",
            "InvalidExpectedSha256",
        ),
        (
            "*** Begin Patch\n*** Add File: a.txt\ncontent\n*** End Patch",
            "InvalidPatch",
        ),
        (
            f"*** Begin Patch\n*** Update File: a.txt\n*** Expected SHA256: {'0' * 64}\n*** End Patch",
            "InvalidPatch",
        ),
    ],
)
def test_apply_patch_rejects_malformed_input(
    tmp_path: Path, monkeypatch, patch: str, error_type: str
) -> None:
    monkeypatch.chdir(tmp_path)
    _error(apply_patch(patch), error_type)


def test_apply_patch_checks_missing_invalid_and_stale_sha(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "source.txt"
    path.write_text("current\n", encoding="utf-8")
    stale = _sha(path)
    path.write_text("external\n", encoding="utf-8")

    missing = """*** Begin Patch
*** Update File: source.txt
@@
-external
+changed
*** End Patch"""
    invalid = """*** Begin Patch
*** Update File: source.txt
*** Expected SHA256: zzz
@@
-external
+changed
*** End Patch"""
    stale_patch = f"""*** Begin Patch
*** Update File: source.txt
*** Expected SHA256: {stale}
@@
-current
+changed
*** End Patch"""

    _error(apply_patch(missing), "PreimageRequired")
    _error(apply_patch(invalid), "InvalidExpectedSha256")
    error = _error(apply_patch(stale_patch), "PreimageMismatch")
    assert path.read_text(encoding="utf-8") == "external\n"
    assert error["meta"]["actual_sha256"] == _sha(path)


def test_apply_patch_rejects_mismatched_and_non_unique_context(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "source.txt"
    path.write_text("same\nmiddle\nsame\n", encoding="utf-8")
    expected = _sha(path)
    mismatch = f"""*** Begin Patch
*** Update File: source.txt
*** Expected SHA256: {expected}
@@
-missing
+changed
*** End Patch"""
    ambiguous = f"""*** Begin Patch
*** Update File: source.txt
*** Expected SHA256: {expected}
@@
-same
+changed
*** End Patch"""

    _error(apply_patch(mismatch), "PatchMismatch")
    _error(apply_patch(ambiguous), "PatchContextNotUnique")
    assert path.read_text(encoding="utf-8") == "same\nmiddle\nsame\n"


def test_apply_patch_rejects_duplicate_targets(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    patch = """*** Begin Patch
*** Add File: same.txt
+one
*** Add File: ./same.txt
+two
*** End Patch"""

    _error(apply_patch(patch), "DuplicatePath")
    assert not (tmp_path / "same.txt").exists()


def test_apply_patch_rejects_target_and_parent_path_errors(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    existing = tmp_path / "existing.txt"
    directory = tmp_path / "directory"
    invalid = tmp_path / "invalid.txt"
    parent_file = tmp_path / "parent-file"
    existing.write_text("old\n", encoding="utf-8")
    directory.mkdir()
    invalid.write_bytes(b"valid\xfftext")
    parent_file.write_text("not a directory", encoding="utf-8")

    cases = [
        (
            "*** Begin Patch\n*** Add File: existing.txt\n+new\n*** End Patch",
            "AlreadyExists",
        ),
        (
            "*** Begin Patch\n*** Add File: directory\n+new\n*** End Patch",
            "NotAFile",
        ),
        (
            f"*** Begin Patch\n*** Update File: missing.txt\n*** Expected SHA256: {'0' * 64}\n@@\n-a\n+b\n*** End Patch",
            "NotFound",
        ),
        (
            f"*** Begin Patch\n*** Update File: directory\n*** Expected SHA256: {'0' * 64}\n@@\n-a\n+b\n*** End Patch",
            "NotAFile",
        ),
        (
            f"*** Begin Patch\n*** Update File: invalid.txt\n*** Expected SHA256: {_sha(invalid)}\n@@\n-a\n+b\n*** End Patch",
            "InvalidEncoding",
        ),
        (
            "*** Begin Patch\n*** Add File: parent-file/child.txt\n+new\n*** End Patch",
            "NotADirectory",
        ),
    ]
    for patch, error_type in cases:
        _error(apply_patch(patch), error_type)

    assert existing.read_text(encoding="utf-8") == "old\n"
    assert not _temp_files(tmp_path)


def test_apply_patch_validation_failure_changes_no_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("first\n", encoding="utf-8")
    second.write_text("second\n", encoding="utf-8")
    stale_second = _sha(second)
    second.write_text("external\n", encoding="utf-8")
    patch = f"""*** Begin Patch
*** Add File: should-not-exist.txt
+new
*** Update File: first.txt
*** Expected SHA256: {_sha(first)}
@@
-first
+changed
*** Update File: second.txt
*** Expected SHA256: {stale_second}
@@
-second
+changed
*** End Patch"""

    _error(apply_patch(patch), "PreimageMismatch")

    assert first.read_text(encoding="utf-8") == "first\n"
    assert second.read_text(encoding="utf-8") == "external\n"
    assert not (tmp_path / "should-not-exist.txt").exists()
    assert not _temp_files(tmp_path)


def test_apply_patch_allows_project_paths_and_exact_user_rind_doc(
    tmp_path: Path, monkeypatch
) -> None:
    project = tmp_path / "project"
    user_doc = tmp_path / "user-home" / "RIND.md"
    project.mkdir()
    monkeypatch.chdir(project)
    monkeypatch.setattr(mutations, "resolve_user_doc_path", lambda: user_doc)

    _ok(apply_patch("*** Begin Patch\n*** Add File: project.txt\n+project\n*** End Patch"))
    _ok(apply_patch(f"*** Begin Patch\n*** Add File: {user_doc}\n+user\n*** End Patch"))
    user_update = f"""*** Begin Patch
*** Update File: {user_doc}
*** Expected SHA256: {_sha(user_doc)}
@@
-user
+updated user
*** End Patch"""
    _ok(apply_patch(user_update))

    assert (project / "project.txt").read_text(encoding="utf-8") == "project\n"
    assert user_doc.read_text(encoding="utf-8") == "updated user\n"


def test_apply_patch_rejects_other_absolute_paths_and_traversal(
    tmp_path: Path, monkeypatch
) -> None:
    project = tmp_path / "project"
    user_doc = tmp_path / "user-home" / "RIND.md"
    other = tmp_path / "other.txt"
    project.mkdir()
    monkeypatch.chdir(project)
    monkeypatch.setattr(mutations, "resolve_user_doc_path", lambda: user_doc)

    absolute = f"*** Begin Patch\n*** Add File: {other}\n+x\n*** End Patch"
    traversal = "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch"
    aliased_user = (
        f"*** Begin Patch\n*** Add File: {user_doc.parent / 'child' / '..' / 'RIND.md'}"
        "\n+x\n*** End Patch"
    )

    _error(apply_patch(absolute), "InvalidPath")
    _error(apply_patch(traversal), "InvalidPath")
    _error(apply_patch(aliased_user), "InvalidPath")
    assert not other.exists()
    assert not user_doc.exists()


def test_apply_patch_preserves_permissions_and_cleans_temp_files(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "mode.txt"
    path.write_text("old\n", encoding="utf-8")
    path.chmod(0o640)
    original_mode = stat.S_IMODE(path.stat().st_mode)
    patch = f"""*** Begin Patch
*** Update File: mode.txt
*** Expected SHA256: {_sha(path)}
@@
-old
+new
*** End Patch"""

    _ok(apply_patch(patch))
    assert stat.S_IMODE(path.stat().st_mode) == original_mode
    assert not _temp_files(tmp_path)

    def fail_replace(source, target) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr(mutations.os, "replace", fail_replace)
    failed_patch = f"""*** Begin Patch
*** Update File: mode.txt
*** Expected SHA256: {_sha(path)}
@@
-new
+uncommitted
*** End Patch"""
    _error(apply_patch(failed_patch), "PatchApplyError")
    assert path.read_text(encoding="utf-8") == "new\n"
    assert not _temp_files(tmp_path)


def test_apply_patch_detects_external_change_before_commit(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "race.txt"
    path.write_text("read version\n", encoding="utf-8")
    patch = f"""*** Begin Patch
*** Update File: race.txt
*** Expected SHA256: {_sha(path)}
@@
-read version
+agent version
*** End Patch"""
    stage_file = mutations._stage_file

    def stage_then_change(target: Path, content: bytes, mode: int | None) -> Path:
        staged = stage_file(target, content, mode)
        target.write_text("external version\n", encoding="utf-8")
        return staged

    monkeypatch.setattr(mutations, "_stage_file", stage_then_change)

    _error(apply_patch(patch), "PreimageMismatch")
    assert path.read_text(encoding="utf-8") == "external version\n"
    assert not _temp_files(tmp_path)


def test_apply_patch_diff_summary_is_bounded(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = _ok(
        apply_patch(
            "*** Begin Patch\n*** Add File: large-line.txt\n+"
            + "x" * 20_000
            + "\n*** End Patch"
        )
    )

    file_meta = result["meta"]["files"][0]
    assert file_meta["added_lines"] == 1
    assert len(file_meta["diff"]) <= 12_000
    assert file_meta["diff"].endswith("... diff truncated ...")


def test_only_apply_patch_mutation_schema_and_runtime_entry_remain() -> None:
    registry = DefaultToolRegistry()
    schemas = {item["function"]["name"]: item["function"] for item in registry.schemas}

    assert "write_file" not in schemas
    assert "edit_file" not in schemas
    assert set(schemas["apply_patch"]["parameters"]["properties"]) == {"patch"}
    assert schemas["apply_patch"]["parameters"]["required"] == ["patch"]
    assert not registry.has("write_file")
    assert not registry.has("edit_file")
    assert not hasattr(mutations, "write_file")
    assert not hasattr(mutations, "edit_file")

    result = ToolExecutor(registry).execute_sync("write_file", {})
    assert result.status == "error"
    assert result.error_type == "ToolNotFound"
    assert result.failure_status == "unavailable"
