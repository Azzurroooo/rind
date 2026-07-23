import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.planning import store as plan_store
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin.planning import update_plan


@pytest.fixture(autouse=True)
def session_context(tmp_path: Path):
    os.environ["AGENT_SESSION_ROOT"] = str(tmp_path)
    os.environ["AGENT_SESSION_ID"] = "test_plan_session"
    (tmp_path / "test_plan_session").mkdir()
    yield
    os.environ.pop("AGENT_SESSION_ROOT", None)
    os.environ.pop("AGENT_SESSION_ID", None)


def payload(raw: str) -> dict:
    result = json.loads(raw)
    assert isinstance(result, dict)
    return result


def test_registry_exposes_one_plan_tool_with_nested_schema() -> None:
    schemas = DefaultToolRegistry().schemas
    plan_schemas = [schema["function"] for schema in schemas if schema["function"]["name"] == "update_plan"]

    assert len(plan_schemas) == 1
    assert not any(schema["function"]["name"].startswith("plan_") for schema in schemas)

    function = plan_schemas[0]
    parameters = function["parameters"]
    assert parameters["required"] == ["plan"]
    item = parameters["properties"]["plan"]["items"]
    assert item["required"] == ["step", "status"]
    assert item["additionalProperties"] is False
    assert item["properties"]["step"] == {"type": "string", "minLength": 1}
    assert item["properties"]["status"]["enum"] == ["pending", "in_progress", "completed", "cancelled"]
    assert "完整列表" in function["description"]


def test_update_plan_writes_v2_and_replaces_previous_list() -> None:
    first = [{"step": " Read code ", "status": "in_progress"}]
    second = [
        {"step": "Read code", "status": "completed"},
        {"step": "Run tests", "status": "pending"},
    ]

    result = payload(update_plan(first))
    assert result["ok"] is True
    assert result["tool"] == "update_plan"
    assert result["data"] == "Plan updated"

    plan_file = Path(os.environ["AGENT_SESSION_ROOT"]) / "test_plan_session" / "plan.json"
    assert json.loads(plan_file.read_text(encoding="utf-8")) == {
        "schema_version": "2.0",
        "plan": [{"step": "Read code", "status": "in_progress"}],
    }
    assert not (plan_file.parent / ("plan" + "_events.jsonl")).exists()

    assert payload(update_plan(second))["data"] == "Plan updated"
    assert json.loads(plan_file.read_text(encoding="utf-8"))["plan"] == second


def test_update_plan_allows_cancelled_and_empty_plan() -> None:
    assert payload(update_plan([{"step": "obsolete", "status": "cancelled"}]))["ok"] is True
    assert payload(update_plan([]))["ok"] is True

    plan_file = Path(os.environ["AGENT_SESSION_ROOT"]) / "test_plan_session" / "plan.json"
    assert json.loads(plan_file.read_text(encoding="utf-8")) == {"schema_version": "2.0", "plan": []}


@pytest.mark.parametrize(
    "plan",
    [
        "not a list",
        [{"step": "", "status": "pending"}],
        [{"step": "x", "status": "blocked"}],
        [{"step": "x", "status": "pending", "extra": "no"}],
        [{"step": "x"}],
        ["x"],
        [{"step": "one", "status": "in_progress"}, {"step": "two", "status": "in_progress"}],
    ],
)
def test_update_plan_rejects_invalid_lists(plan) -> None:
    result = payload(update_plan(plan))
    assert result["ok"] is False
    assert result["tool"] == "update_plan"
    assert result["error_type"] == "ValidationError"


def test_update_plan_rejects_invalid_session_id(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SESSION_ID", "../escape")

    result = payload(update_plan([]))

    assert result["ok"] is False
    assert result["error_type"] == "ValidationError"


def test_atomic_write_failure_keeps_old_file_and_cleans_temp(monkeypatch) -> None:
    assert payload(update_plan([{"step": "old", "status": "pending"}]))["ok"] is True
    plan_file, _ = plan_store.plan_path()
    original = plan_file.read_text(encoding="utf-8")
    real_replace = os.replace

    def fail_replace(source, destination):
        if destination == plan_file:
            raise OSError("replace failed")
        return real_replace(source, destination)

    monkeypatch.setattr(plan_store.os, "replace", fail_replace)
    result = payload(update_plan([{"step": "new", "status": "completed"}]))

    assert result["ok"] is False
    assert result["error_type"] == "OSError"
    assert plan_file.read_text(encoding="utf-8") == original
    assert list(plan_file.parent.glob("plan.json.*.tmp")) == []
