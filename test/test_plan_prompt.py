import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.prompts import SYSTEM_PROMPT


def test_system_prompt_plan_control_state_only() -> None:
    forbidden = [
        "plan_record_observation",
        "Record experiment, backtest, or validation observations",
        "call `plan_record_observation`",
    ]
    for text in forbidden:
        if text in SYSTEM_PROMPT:
            raise AssertionError(f"Unexpected prompt text: {text}")
    if "Plan records task control state only" not in SYSTEM_PROMPT:
        raise AssertionError("Expected control-state-only plan rule in system prompt.")


if __name__ == "__main__":
    test_system_prompt_plan_control_state_only()
    print("Plan prompt tests passed.")
