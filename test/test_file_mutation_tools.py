"""Atomic file mutation tests."""

from __future__ import annotations

import json
from pathlib import Path
import stat
import sys

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.files.specs import edit_file, write_file
from agent.infrastructure.tools.files import mutations


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


def _temp_files(directory: Path) -> list[Path]:
    return [path for path in directory.rglob("*.tmp") if path.name.startswith(".")]


def test_write_file_creates_new_file_with_diff_summary(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "new.txt"

    result = _ok(write_file(str(path), "one\ntwo\n"))

    assert path.read_text(encoding="utf-8") == "one\ntwo\n"
    file_meta = result["meta"]["files"][0]
    assert file_meta["path"] == str(path.resolve())
    assert (file_meta["added_lines"], file_meta["removed_lines"]) == (2, 0)
    assert "+one" in file_meta["diff"]
    assert not _temp_files(tmp_path)


def test_write_file_overwrites_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "existing.txt"
    path.write_text("old\n", encoding="utf-8")

    result = _ok(write_file(str(path), "new\n"))

    assert path.read_text(encoding="utf-8") == "new\n"
    assert (result["meta"]["files"][0]["added_lines"], result["meta"]["files"][0]["removed_lines"]) == (1, 1)


def test_edit_file_checks_unique_exact_content(tmp_path: Path) -> None:
    path = tmp_path / "edit.txt"
    path.write_text("before\nunique\nafter\n", encoding="utf-8")

    result = _ok(edit_file(str(path), "unique", "changed"))

    assert path.read_text(encoding="utf-8") == "before\nchanged\nafter\n"
    file_meta = result["meta"]["files"][0]
    assert (file_meta["added_lines"], file_meta["removed_lines"]) == (1, 1)
    assert "-unique" in file_meta["diff"] and "+changed" in file_meta["diff"]

    _error(edit_file(str(path), "missing", "x"), "OldStrNotFound")
    path.write_text("same\nsame\n", encoding="utf-8")
    _error(edit_file(str(path), "same", "x"), "OldStrNotUnique")
    assert path.read_text(encoding="utf-8") == "same\nsame\n"
    path.write_text("ababa", encoding="utf-8")
    _error(edit_file(str(path), "aba", "x"), "OldStrNotUnique")
    assert path.read_text(encoding="utf-8") == "ababa"


@pytest.mark.parametrize("existing", [True, False])
def test_mutations_detect_external_changes_before_commit(tmp_path: Path, monkeypatch, existing) -> None:
    path = tmp_path / "race.txt"
    if existing:
        path.write_text("read version\n", encoding="utf-8")
    stage = mutations._stage_file

    def change_target(*args):
        staged = stage(*args)
        path.write_text("external version\n", encoding="utf-8")
        return staged

    monkeypatch.setattr(mutations, "_stage_file", change_target)
    _error(write_file(str(path), "agent version\n"), "PreimageMismatch")

    assert path.read_text(encoding="utf-8") == "external version\n"
    assert not _temp_files(tmp_path)


def test_mutations_reject_invalid_encoding_and_paths(tmp_path: Path) -> None:
    invalid = tmp_path / "invalid.txt"
    invalid.write_bytes(b"valid\xfftext")
    _error(edit_file(str(invalid), "a", "b"), "InvalidEncoding")
    _error(edit_file(str(tmp_path / "missing.txt"), "a", "b"), "NotFound")
    _error(write_file(str(tmp_path), "content"), "NotAFile")


def test_atomic_replace_preserves_permissions_and_cleans_temp_files(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "mode.txt"
    path.write_text("old\n", encoding="utf-8")
    path.chmod(0o640)
    original_mode = stat.S_IMODE(path.stat().st_mode)

    _ok(write_file(str(path), "new\n"))
    assert stat.S_IMODE(path.stat().st_mode) == original_mode
    assert not _temp_files(tmp_path)

    def fail_replace(source, target) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr(mutations.os, "replace", fail_replace)
    _error(write_file(str(path), "uncommitted\n"), "WriteError")
    assert path.read_text(encoding="utf-8") == "new\n"
    assert not _temp_files(tmp_path)


def test_diff_summary_is_bounded(tmp_path: Path) -> None:
    path = tmp_path / "large-line.txt"

    result = _ok(write_file(str(path), "x" * 20_000 + "\n"))

    file_meta = result["meta"]["files"][0]
    assert file_meta["added_lines"] == 1
    assert len(file_meta["diff"]) <= 12_000
    assert file_meta["diff"].endswith("... diff truncated ...")


def test_file_mutation_schemas_need_no_hash_and_apply_patch_is_absent(build_builtin_tool_specs) -> None:
    registry = DefaultToolRegistry(build_builtin_tool_specs())
    schemas = {item["function"]["name"]: item["function"] for item in registry.schemas}

    assert set(schemas["write_file"]["parameters"]["properties"]) == {
        "path",
        "content",
    }
    assert set(schemas["edit_file"]["parameters"]["properties"]) == {
        "path",
        "old_str",
        "new_str",
    }
    assert set(schemas["edit_file"]["parameters"]["required"]) == {"path", "old_str", "new_str"}
    assert set(schemas["write_file"]["parameters"]["required"]) == {"path", "content"}
    assert not registry.has("apply_patch")
