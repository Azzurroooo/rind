import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain import tool_cancelled


def test_tool_cancelled_shape() -> None:
    payload = json.loads(tool_cancelled("read_file", "unit test"))

    assert payload["ok"] is False
    assert payload["tool"] == "read_file"
    assert payload["error"] == "Tool cancelled: unit test"
    assert payload["error_type"] == "Cancelled"
    assert payload["meta"] == {"reason": "unit test"}


def test_tool_cancelled_defaults_reason() -> None:
    payload = json.loads(tool_cancelled("read_file"))

    assert payload["error"] == "Tool cancelled: cancelled"
    assert payload["meta"] == {"reason": "cancelled"}


def main() -> int:
    test_tool_cancelled_shape()
    test_tool_cancelled_defaults_reason()
    print("Tool result tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
