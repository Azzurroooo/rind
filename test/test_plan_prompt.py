import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.prompts import SYSTEM_PROMPT


def test_system_prompt_describes_single_update_plan_protocol() -> None:
    assert "`update_plan`" in SYSTEM_PROMPT
    assert "complete list" in SYSTEM_PROMPT
    for status in ("pending", "in_progress", "completed", "cancelled"):
        assert status in SYSTEM_PROMPT
    assert "at most one" in SYSTEM_PROMPT
    assert "Plan records task control state only" in SYSTEM_PROMPT
    assert "Do not introduce a `blocked` status" in SYSTEM_PROMPT


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
