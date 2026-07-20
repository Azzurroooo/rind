import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.interfaces.cli.status.activity import tool_activity_summary


def test_tool_activity_summary_for_bash_command() -> None:
    assert tool_activity_summary("bash", '{"command":"pytest -q"}') == "bash: pytest -q"


def test_tool_activity_summary_for_grep() -> None:
    assert tool_activity_summary("grep", '{"pattern":"TODO","path":"agent"}') == "grep: TODO in agent"


def test_tool_activity_summary_for_invalid_args_falls_back_to_name() -> None:
    assert tool_activity_summary("bash", "{") == "bash"


def test_tool_activity_summary_truncates_long_detail() -> None:
    text = tool_activity_summary("bash", '{"command":"' + ("x" * 200) + '"}', max_len=20)

    assert text == "bash: xxxxxxxxxxxxxxxxx..."


def main() -> int:
    test_tool_activity_summary_for_bash_command()
    test_tool_activity_summary_for_grep()
    test_tool_activity_summary_for_invalid_args_falls_back_to_name()
    test_tool_activity_summary_truncates_long_detail()
    print("CLI tool activity tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
