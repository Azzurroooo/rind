import os
import sys
from pathlib import Path

from prompt_toolkit.document import Document

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.interfaces.cli.commands import SlashCommandInfo
from agent.interfaces.cli.commands.completer import SlashCommandCompleter


def _texts(completer: SlashCommandCompleter, text: str) -> list[str]:
    return [item.text for item in completer.get_completions(Document(text), None)]


def test_slash_completer_matches_command_prefix() -> None:
    completer = SlashCommandCompleter(["help", "status", "sessions"])

    assert _texts(completer, "/s") == ["/sessions", "/status"]


def test_slash_completer_ignores_non_slash_input() -> None:
    completer = SlashCommandCompleter(["help"])

    assert _texts(completer, "help") == []


def test_slash_completer_ignores_command_arguments() -> None:
    completer = SlashCommandCompleter(["model"])

    assert _texts(completer, "/model set") == []


def test_slash_completer_completes_help_arguments() -> None:
    completer = SlashCommandCompleter(["help", "status", "sessions"])

    assert _texts(completer, "/help s") == ["sessions", "status"]


def test_slash_completer_completes_draft_clear_argument() -> None:
    completer = SlashCommandCompleter(["draft"])

    assert _texts(completer, "/draft c") == ["clear"]
    assert _texts(completer, "/draft u") == ["use"]


def test_slash_completer_replaces_only_help_argument_token() -> None:
    completer = SlashCommandCompleter(["status"])
    completion = list(completer.get_completions(Document("/help st"), None))[0]

    assert completion.text == "status"
    assert completion.start_position == -2


def test_slash_completer_replaces_only_slash_token() -> None:
    completer = SlashCommandCompleter(["status"])
    completion = list(completer.get_completions(Document("  /st"), None))[0]

    assert completion.text == "/status"
    assert completion.start_position == -3


def test_slash_completer_shows_command_description() -> None:
    completer = SlashCommandCompleter([SlashCommandInfo("status", "Show session status")])
    completion = list(completer.get_completions(Document("/st"), None))[0]

    assert completion.text == "/status"
    assert completion.display_meta_text == "Show session status"


def main() -> int:
    test_slash_completer_matches_command_prefix()
    test_slash_completer_ignores_non_slash_input()
    test_slash_completer_ignores_command_arguments()
    test_slash_completer_completes_help_arguments()
    test_slash_completer_completes_draft_clear_argument()
    test_slash_completer_replaces_only_help_argument_token()
    test_slash_completer_replaces_only_slash_token()
    test_slash_completer_shows_command_description()
    print("CLI slash completer tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
