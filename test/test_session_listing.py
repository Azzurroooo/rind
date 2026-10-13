"""Session listing: per-folder windows, totals and the index read cache."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.infrastructure.persistence.session_index_repository import SessionIndexRepository


def _write_index(root: Path, entries: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.json").write_text(json.dumps({"sessions": entries}), encoding="utf-8")


def _entry(session_id: str, workspace: str, updated_at: str) -> dict:
    return {"id": session_id, "workspace_root": workspace, "updated_at": updated_at, "has_user_message": True}


def test_grouped_listing_keeps_the_newest_per_folder_with_totals(tmp_path):
    sessions = tmp_path / "sessions"
    alpha, beta = tmp_path / "alpha", tmp_path / "beta"
    _write_index(sessions, [
        _entry("20260101_a1", str(alpha), "2026-01-01T00:00:01"),
        _entry("20260101_a2", str(alpha), "2026-01-02T00:00:02"),
        _entry("20260101_a3", str(alpha), "2026-01-03T00:00:03"),
        _entry("20260101_a4", str(alpha), "2026-01-04T00:00:04"),
        _entry("20260101_a5", str(alpha), "2026-01-05T00:00:05"),
        _entry("20260101_b1", str(beta), "2026-01-06T00:00:06"),
        _entry("20260101_b2", str(beta), "2026-01-07T00:00:07"),
    ])

    kept, totals = JsonlSessionStore.list_session_metadata_by_workspace(str(sessions), per_workspace_limit=3)

    assert [entry["id"] for entry in kept][:3] == ["20260101_b2", "20260101_b1", "20260101_a5"], "newest first"
    assert sorted(entry["id"] for entry in kept) == ["20260101_a3", "20260101_a4", "20260101_a5", "20260101_b1", "20260101_b2"], "3 per folder at most"
    counts = {Path(total["workspace_root"]).name: total["count"] for total in totals}
    assert counts == {"alpha": 5, "beta": 2}
    for total in totals:
        assert any(entry["workspace_root"] == total["workspace_root"] for entry in kept), "a total names a returned folder"


def test_grouped_listing_applies_exclusions_before_grouping(tmp_path):
    sessions = tmp_path / "sessions"
    alpha, beta = tmp_path / "alpha", tmp_path / "beta"
    _write_index(sessions, [
        _entry("20260101_a1", str(alpha), "2026-01-01T00:00:01"),
        _entry("20260101_b1", str(beta), "2026-01-02T00:00:02"),
    ])

    kept, totals = JsonlSessionStore.list_session_metadata_by_workspace(str(sessions), exclude_workspace_roots=[str(alpha) + os.sep])

    assert [entry["id"] for entry in kept] == ["20260101_b1"]
    assert [Path(total["workspace_root"]).name for total in totals] == ["beta"]


def test_index_read_cache_sees_writes(tmp_path):
    sessions = tmp_path / "sessions"
    _write_index(sessions, [_entry("20260101_a1", str(tmp_path / "alpha"), "2026-01-01T00:00:01")])
    repository = SessionIndexRepository(SessionFiles(), str(sessions / "index.json"))

    first = repository.load_index()
    assert first is repository.load_index(), "an unchanged index is parsed once"

    repository.update_index(_entry("20260101_a2", str(tmp_path / "alpha"), "2026-01-02T00:00:02"))
    assert [entry["id"] for entry in repository.load_index()["sessions"]] == ["20260101_a1", "20260101_a2"], "a write invalidates the cache"

    repository.remove_session("20260101_a1")
    assert [entry["id"] for entry in repository.load_index()["sessions"]] == ["20260101_a2"]


def test_listing_stays_current_after_index_writes(tmp_path):
    sessions = tmp_path / "sessions"
    alpha = tmp_path / "alpha"
    _write_index(sessions, [_entry("20260101_a1", str(alpha), "2026-01-01T00:00:01")])

    assert len(JsonlSessionStore.list_session_metadata(str(sessions), limit=10)) == 1
    repository = SessionIndexRepository(SessionFiles(), str(sessions / "index.json"))
    repository.update_index(_entry("20260101_a2", str(alpha), "2026-01-02T00:00:02"))

    listed = JsonlSessionStore.list_session_metadata(str(sessions), limit=10)
    assert [entry["id"] for entry in listed] == ["20260101_a2", "20260101_a1"]
