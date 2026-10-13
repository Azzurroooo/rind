import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import json

from agent.infrastructure.tools.planning import create_plan_tool_spec
from agent.prompts import build_system_prompt

UPDATE_PLAN_SPEC = create_plan_tool_spec(None)

SYSTEM_PROMPT = build_system_prompt(environment="test environment")


def test_system_prompt_defers_plan_mechanics_to_the_tool_schema() -> None:
    assert "`update_plan`" in SYSTEM_PROMPT
    assert "complete list" in SYSTEM_PROMPT
    assert "Plan records task control state only" in SYSTEM_PROMPT

    schema = json.dumps(UPDATE_PLAN_SPEC.schema)
    for status in ("pending", "in_progress", "completed", "cancelled"):
        assert status in schema
    assert "at most one" in schema
    assert "Stores control state only" in schema



def test_system_prompt_has_no_legacy_plan_protocol() -> None:
    forbidden = tuple(
        "plan_" + suffix
        for suffix in (
            "create",
            "get",
            "add_step",
            "update_meta",
            "update_step",
            "link_dependency",
            "reorder",
            "next",
            "close",
            "record_observation",
        )
    ) + ("D" + "AG", "expected" + "_version")
    assert not [value for value in forbidden if value in SYSTEM_PROMPT]
