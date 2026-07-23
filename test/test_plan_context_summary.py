import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.planning.summary import build_plan_snapshot, render_plan_summary


def _set_session(tmp_path: Path) -> Path:
    os.environ["AGENT_SESSION_ROOT"] = str(tmp_path)
    os.environ["AGENT_SESSION_ID"] = "summary_session"
    base = tmp_path / "summary_session"
    base.mkdir()
    return base


def _write(base: Path, value: dict) -> None:
    (base / "plan.json").write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def teardown_module() -> None:
    os.environ.pop("AGENT_SESSION_ROOT", None)
    os.environ.pop("AGENT_SESSION_ID", None)


def test_render_plan_summary_contains_all_items_and_progress() -> None:
    plan = [
        {"step": "done", "status": "completed"},
        {"step": "now", "status": "in_progress"},
        {"step": "later", "status": "pending"},
        {"step": "cancelled", "status": "cancelled"},
    ]

    text = render_plan_summary(plan)

    assert text == (
        "Active plan:\n"
        "- [completed] done\n"
        "- [in_progress] now\n"
        "- [pending] later\n"
        "- [cancelled] cancelled\n"
        "- Progress: completed=1, in_progress=1, pending=1, cancelled=1"
    )
    for old_field in ("goal", "objectives", "constraints", "focus", "version"):
        assert old_field not in text


def test_snapshot_uses_v2_plan_and_ignores_empty_or_old_schema(tmp_path: Path) -> None:
    base = _set_session(tmp_path)

    assert build_plan_snapshot() == ""
    _write(base, {"schema_version": "1.1", "status": "active", "steps": []})
    assert build_plan_snapshot() == ""
    _write(base, {"schema_version": "2.0", "plan": []})
    assert build_plan_snapshot() == ""

    _write(base, {"schema_version": "2.0", "plan": [{"step": "keep", "status": "pending"}]})
    assert build_plan_snapshot().startswith("Active plan:\n- [pending] keep")


def test_snapshot_truncates_long_steps(tmp_path: Path) -> None:
    base = _set_session(tmp_path)
    _write(base, {"schema_version": "2.0", "plan": [{"step": "x" * 500, "status": "pending"}]})

    text = build_plan_snapshot(char_limit=100)

    assert len(text) <= 100
    assert "plan summary truncated" in text


def test_corrupt_plan_does_not_escape_snapshot(tmp_path: Path) -> None:
    base = _set_session(tmp_path)
    (base / "plan.json").write_text("{bad json", encoding="utf-8")

    assert build_plan_snapshot() == ""
