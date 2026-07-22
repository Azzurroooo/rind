"""Atomic file mutation and strict patch tests."""

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

from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin.files import apply_patch, edit_file, write_file
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


def test_write_file_creates_new_file_with_unified_summary(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "new.txt"

    result = _ok(write_file(str(path), "one\ntwo\n"))

    assert path.read_text(encoding="utf-8") == "one\ntwo\n"
    assert set(result["meta"]) == {"files"}
    assert result["meta"]["files"] == [
        {
            "path": str(path.resolve()),
            "added_lines": 2,
            "removed_lines": 0,
            "diff": result["meta"]["files"][0]["diff"],
        }
    ]
    assert "+one" in result["meta"]["files"][0]["diff"]
    assert not _temp_files(tmp_path)


def test_write_file_existing_requires_valid_matching_preimage(tmp_path: Path) -> None:
    path = tmp_path / "existing.txt"
    path.write_text("old\n", encoding="utf-8")

    _error(write_file(str(path), "new\n"), "PreimageRequired")
    _error(write_file(str(path), "new\n", "bad"), "InvalidExpectedSha256")
    assert path.read_text(encoding="utf-8") == "old\n"

    result = _ok(write_file(str(path), "new\n", _sha(path)))
    assert path.read_text(encoding="utf-8") == "new\n"
    assert result["meta"]["files"][0]["added_lines"] == 1
    assert result["meta"]["files"][0]["removed_lines"] == 1


def test_edit_file_checks_preimage_and_exact_content(tmp_path: Path) -> None:
    path = tmp_path / "edit.txt"
    path.write_text("before\nunique\nafter\n", encoding="utf-8")
    expected = _sha(path)

    result = _ok(edit_file(str(path), "unique", "changed", expected))

    assert path.read_text(encoding="utf-8") == "before\nchanged\nafter\n"
    file_meta = result["meta"]["files"][0]
    assert (file_meta["added_lines"], file_meta["removed_lines"]) == (1, 1)
    assert "-unique" in file_meta["diff"] and "+changed" in file_meta["diff"]

    current = _sha(path)
    _error(edit_file(str(path), "missing", "x", current), "OldStrNotFound")
    path.write_text("same\nsame\n", encoding="utf-8")
    _error(edit_file(str(path), "same", "x", _sha(path)), "OldStrNotUnique")


def test_external_change_returns_preimage_mismatch_without_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "race.txt"
    path.write_text("read version\n", encoding="utf-8")
    stale_hash = _sha(path)
    path.write_text("external version\n", encoding="utf-8")

    error = _error(write_file(str(path), "agent version\n", stale_hash), "PreimageMismatch")

    assert path.read_text(encoding="utf-8") == "external version\n"
    assert error["meta"]["actual_sha256"] == _sha(path)


def test_mutations_reject_missing_directory_invalid_encoding_and_hash(tmp_path: Path) -> None:
    missing = tmp_path / "missing.txt"
    directory = tmp_path / "directory"
    directory.mkdir()
    invalid = tmp_path / "invalid.txt"
    invalid.write_bytes(b"valid\xfftext")

    _error(edit_file(str(missing), "a", "b", "0" * 64), "NotFound")
    _error(write_file(str(directory), "content", "0" * 64), "NotAFile")
    _error(edit_file(str(invalid), "a", "b", _sha(invalid)), "InvalidEncoding")
    _error(edit_file(str(invalid), "a", "b", "z" * 64), "InvalidExpectedSha256")
    valid = tmp_path / "valid.txt"
    valid.write_text("a", encoding="utf-8")
    _error(edit_file(str(valid), "a", "b", None), "PreimageRequired")
    _error(edit_file(str(valid), "", "b", _sha(valid)), "InvalidContent")

    blocked_child = tmp_path / "parent-file" / "child.txt"
    blocked_child.parent.write_text("not a directory", encoding="utf-8")
    _error(write_file(str(blocked_child), "content"), "NotADirectory")


def test_atomic_replace_preserves_permissions_and_cleans_temp_files(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "mode.txt"
    path.write_text("old\n", encoding="utf-8")
    path.chmod(0o640)
    original_mode = stat.S_IMODE(path.stat().st_mode)

    _ok(write_file(str(path), "new\n", _sha(path)))
    assert stat.S_IMODE(path.stat().st_mode) == original_mode
    assert not _temp_files(tmp_path)

    actual_replace = mutations.os.replace

    def fail_replace(source, target) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr(mutations.os, "replace", fail_replace)
    _error(write_file(str(path), "uncommitted\n", _sha(path)), "WriteError")
    assert path.read_text(encoding="utf-8") == "new\n"
    assert not _temp_files(tmp_path)
    monkeypatch.setattr(mutations.os, "replace", actual_replace)


def test_apply_patch_adds_updates_and_deletes_multiple_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    update_path = tmp_path / "update.txt"
    delete_path = tmp_path / "delete.txt"
    update_path.write_text("alpha\none\nmiddle\ntwo\nomega\n", encoding="utf-8")
    delete_path.write_text("remove me\n", encoding="utf-8")
    patch = f"""*** Begin Patch
*** Add File: added.txt
+created
+file
*** Update File: update.txt
*** Expected SHA256: {_sha(update_path)}
@@
 alpha
-one
+ONE
@@
 middle
-two
+TWO
 omega
*** Delete File: delete.txt
*** Expected SHA256: {_sha(delete_path)}
*** End Patch"""

    result = _ok(apply_patch(patch))

    assert (tmp_path / "added.txt").read_text(encoding="utf-8") == "created\nfile\n"
    assert update_path.read_text(encoding="utf-8") == "alpha\nONE\nmiddle\nTWO\nomega\n"
    assert not delete_path.exists()
    files = result["meta"]["files"]
    assert [Path(item["path"]).name for item in files] == ["added.txt", "update.txt", "delete.txt"]
    assert [(item["added_lines"], item["removed_lines"]) for item in files] == [(2, 0), (2, 2), (0, 1)]
    assert all(set(item) == {"path", "added_lines", "removed_lines", "diff"} for item in files)
    assert not _temp_files(tmp_path)


def test_apply_patch_validation_failure_changes_no_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "source.txt"
    path.write_text("current\n", encoding="utf-8")
    patch = f"""*** Begin Patch
*** Add File: should-not-exist.txt
+new
*** Update File: source.txt
*** Expected SHA256: {_sha(path)}
@@
-stale
+changed
*** End Patch"""

    _error(apply_patch(patch), "PatchMismatch")

    assert path.read_text(encoding="utf-8") == "current\n"
    assert not (tmp_path / "should-not-exist.txt").exists()
    assert not _temp_files(tmp_path)


def test_apply_patch_preimage_failure_changes_no_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("first\n", encoding="utf-8")
    second.write_text("second\n", encoding="utf-8")
    stale_second = _sha(second)
    second.write_text("external\n", encoding="utf-8")
    patch = f"""*** Begin Patch
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


@pytest.mark.parametrize(
    ("patch", "error_type"),
    [
        ("--- a.txt\n+++ a.txt", "InvalidPatch"),
        ("*** Begin Patch\n*** Move to: b.txt\n*** End Patch", "InvalidPatch"),
        ("*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch", "InvalidPath"),
        (
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch",
            "PreimageRequired",
        ),
    ],
)
def test_apply_patch_rejects_malformed_and_invalid_paths(
    tmp_path: Path, monkeypatch, patch: str, error_type: str
) -> None:
    monkeypatch.chdir(tmp_path)
    _error(apply_patch(patch), error_type)


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


def test_diff_summary_is_bounded(tmp_path: Path) -> None:
    path = tmp_path / "large-line.txt"

    result = _ok(write_file(str(path), "x" * 20_000 + "\n"))

    file_meta = result["meta"]["files"][0]
    assert file_meta["added_lines"] == 1
    assert len(file_meta["diff"]) <= 12_000
    assert file_meta["diff"].endswith("... diff truncated ...")


def test_file_mutation_schemas_are_minimal_and_versioned() -> None:
    schemas = {item["function"]["name"]: item["function"] for item in DefaultToolRegistry().schemas}

    assert set(schemas["write_file"]["parameters"]["properties"]) == {
        "file_path",
        "content",
        "expected_sha256",
    }
    assert set(schemas["edit_file"]["parameters"]["properties"]) == {
        "file_path",
        "old_str",
        "new_str",
        "expected_sha256",
    }
    assert "expected_sha256" in schemas["edit_file"]["parameters"]["required"]
    assert set(schemas["apply_patch"]["parameters"]["properties"]) == {"patch"}
    assert schemas["apply_patch"]["parameters"]["required"] == ["patch"]
