import io
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.history import InMemoryHistory

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.events import TokenStatsUpdatedEvent, ToolResultEvent, TurnFailedEvent, UserQuestionRequestedEvent
from agent.interfaces.cli.chat_cli import ChatCLI
from agent.interfaces.cli.ui import GitPromptStatus


def test_chat_cli_turn_failed_event_prints_error_field() -> None:
    cli = ChatCLI(runtime=None, session=None)
    output = io.StringIO()

    with redirect_stdout(output):
        cli._on_event(TurnFailedEvent(error="boom"))

    text = output.getvalue()
    if "boom" not in text:
        raise AssertionError(f"Expected CLI failure output to include error field, got: {text!r}")
    if "unknown" in text:
        raise AssertionError(f"Did not expect fallback output when error exists, got: {text!r}")


def test_chat_cli_tool_result_failed_uses_failed_status() -> None:
    cli = ChatCLI(runtime=None, session=None)
    output = io.StringIO()

    with redirect_stdout(output):
        cli._on_event(ToolResultEvent(tool_name="bash", status="failed"))

    text = output.getvalue()
    if "Tool: bash failed" not in text:
        raise AssertionError(f"Expected CLI to render failed tool status, got: {text!r}")


def test_chat_cli_banner_mentions_core_shortcuts() -> None:
    cli = ChatCLI(runtime=None, session=None)
    output = io.StringIO()

    with redirect_stdout(output):
        cli._render_banner()

    text = output.getvalue()
    if "Type /help" not in text or "Ctrl+J newline" not in text or "Ctrl+L clear" not in text:
        raise AssertionError(f"Expected banner shortcut hints, got: {text!r}")
    if "Ctrl+O history" not in text or "Ctrl+C drafts" not in text:
        raise AssertionError(f"Expected banner shortcut hints, got: {text!r}")


def test_chat_cli_prompt_uses_status_toolbar(monkeypatch) -> None:
    captured = {}

    class FakeSession:
        session_id = "session_1234567890"
        model = "model_a"

    class FakePromptSession:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def prompt(self, message, **kwargs):
            captured["message"] = message
            captured["default"] = kwargs.get("default", "")
            captured["toolbar"] = captured["bottom_toolbar"]()
            captured["continuation"] = captured["prompt_continuation"](0, 2, False)
            return "hello"

    monkeypatch.setattr("agent.interfaces.cli.chat_cli.PromptSession", FakePromptSession)

    cli = ChatCLI(runtime=None, session=FakeSession(), debug=True)
    cli._git_status_provider.current = lambda: GitPromptStatus(branch="main", dirty=True)

    if cli._read_user_input() != "hello":
        raise AssertionError("Expected prompt result to be returned")
    if captured["message"] != "\nYou > ":
        raise AssertionError(f"Expected speaker prompt, got: {captured['message']!r}")
    if captured["default"] != "":
        raise AssertionError(f"Expected empty prompt prefill, got: {captured['default']!r}")
    if captured.get("completer") is None:
        raise AssertionError("Expected slash command completer")
    if captured.get("complete_while_typing") is not True:
        raise AssertionError("Expected completion while typing")
    if not isinstance(captured.get("history"), InMemoryHistory):
        raise AssertionError("Expected in-memory prompt history")
    if not isinstance(captured.get("auto_suggest"), AutoSuggestFromHistory):
        raise AssertionError("Expected history-based auto suggestions")
    if "session session_...7890" not in captured["toolbar"]:
        raise AssertionError(f"Expected session in toolbar, got: {captured['toolbar']!r}")
    if "model model_a" not in captured["toolbar"] or "debug on" not in captured["toolbar"]:
        raise AssertionError(f"Expected model/debug in toolbar, got: {captured['toolbar']!r}")
    if "git main*" not in captured["toolbar"]:
        raise AssertionError(f"Expected git status in toolbar, got: {captured['toolbar']!r}")
    if captured["continuation"] != "  ... ":
        raise AssertionError(f"Expected multiline continuation, got: {captured['continuation']!r}")


def test_chat_cli_prompt_toolbar_uses_latest_usage(monkeypatch) -> None:
    captured = {}

    class FakeSession:
        session_id = "session_1234567890"
        model = "model_a"

    class FakePromptSession:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def prompt(self, message, **kwargs):
            captured["toolbar"] = captured["bottom_toolbar"]()
            return "hello"

    monkeypatch.setattr("agent.interfaces.cli.chat_cli.PromptSession", FakePromptSession)

    cli = ChatCLI(runtime=None, session=FakeSession())
    cli._latest_usage = {"context_usage_percent": 0.5, "cache_hit_rate": 0.25}
    cli._read_user_input()

    if "ctx 50.0% cache 25.0%" not in captured["toolbar"]:
        raise AssertionError(f"Expected latest usage in toolbar, got: {captured['toolbar']!r}")


async def _load_latest_usage(cli: ChatCLI) -> None:
    await cli._load_latest_usage_async()


def test_chat_cli_loads_latest_usage_from_session() -> None:
    import asyncio

    class FakeSession:
        async def get_latest_sampling_usage(self):
            return {"context_usage_percent": 0.3}

    cli = ChatCLI(runtime=None, session=FakeSession())
    asyncio.run(_load_latest_usage(cli))

    if cli._latest_usage != {"context_usage_percent": 0.3}:
        raise AssertionError(f"Expected persisted usage to be loaded, got: {cli._latest_usage!r}")


def test_chat_cli_prefers_assistant_usage_over_latest_request_usage() -> None:
    import asyncio

    class FakeSession:
        async def get_latest_assistant_sampling_usage(self):
            return {"sampling_kind": "assistant", "context_usage_percent": 0.5}

        async def get_latest_sampling_usage(self):
            return {"sampling_kind": "compact", "context_usage_percent": 0.1}

    cli = ChatCLI(runtime=None, session=FakeSession())
    asyncio.run(_load_latest_usage(cli))

    if cli._latest_usage != {"sampling_kind": "assistant", "context_usage_percent": 0.5}:
        raise AssertionError(f"Expected assistant usage to be loaded, got: {cli._latest_usage!r}")


def test_chat_cli_token_event_updates_latest_usage() -> None:
    cli = ChatCLI(runtime=None, session=None)
    output = io.StringIO()
    cli._console.file = output
    cli._status_renderer._console.file = output

    cli._on_event(TokenStatsUpdatedEvent(stats={"context_usage_percent": 0.5}))

    if cli._latest_usage != {"context_usage_percent": 0.5}:
        raise AssertionError(f"Expected token usage state to update, got: {cli._latest_usage!r}")
    if "Tokens:" not in output.getvalue():
        raise AssertionError(f"Expected token status to still render, got: {output.getvalue()!r}")


def test_chat_cli_loaded_messages_are_compact(monkeypatch) -> None:
    class FakeSession:
        session_id = "session_1234567890"

        async def get_messages_slice(self):
            messages = [{"role": "system", "content": "sys"}]
            messages.extend(
                {"role": "user", "content": f"old question {index} that should stay hidden"}
                for index in range(5)
            )
            messages.extend(
                [
                    {"role": "user", "content": "latest question"},
                    {"role": "assistant", "content": "latest answer"},
                ]
            )
            return messages

    class FakeLoop:
        def run_until_complete(self, awaitable):
            import asyncio

            return asyncio.run(awaitable)

    output = io.StringIO()
    cli = ChatCLI(runtime=None, session=FakeSession())
    cli._event_loop = FakeLoop()
    cli._console.file = output

    with redirect_stdout(output):
        cli._render_loaded_messages()

    text = output.getvalue()
    if "Resumed session session_1234567890" not in text:
        raise AssertionError(f"Expected compact resume header, got: {text!r}")
    if "latest question" not in text or "latest answer" not in text:
        raise AssertionError(f"Expected latest messages, got: {text!r}")
    if "old question 0" in text:
        raise AssertionError(f"Expected oldest messages to stay hidden, got: {text!r}")
    if "\nuser:\n" in text or "[历史会话]" in text:
        raise AssertionError(f"Expected old full transcript rendering to be gone, got: {text!r}")


def test_chat_cli_expands_recent_resume_messages_in_chronological_order() -> None:
    long_previous_message = "previous question " + ("x" * 240)

    class FakeSession:
        session_id = "session_1234567890"

        async def get_messages_slice(self):
            return [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "oldest question"},
                {"role": "user", "content": long_previous_message},
                {"role": "assistant", "content": "latest answer"},
            ]

    class FakeLoop:
        def run_until_complete(self, awaitable):
            import asyncio

            return asyncio.run(awaitable)

    cli = ChatCLI(runtime=None, session=FakeSession())
    cli._event_loop = FakeLoop()

    preview_output = io.StringIO()
    cli._console.file = preview_output
    with redirect_stdout(preview_output):
        cli._render_loaded_messages()

    preview_text = preview_output.getvalue()
    if "3 visible message(s), showing last 3" not in preview_text:
        raise AssertionError(f"Expected compact preview for all visible messages, got: {preview_text!r}")
    if "older message(s) are hidden" in preview_text:
        raise AssertionError(f"Did not expect hidden-message notice, got: {preview_text!r}")

    first_output = io.StringIO()
    cli._console.file = first_output
    cli._render_next_resume_message()
    first_text = first_output.getvalue()
    if "Expanded resume history: showing 1 most recent message(s)." not in first_text:
        raise AssertionError(f"Expected one expanded message, got: {first_text!r}")
    if "History 3/3 - assistant" not in first_text or "latest answer" not in first_text:
        raise AssertionError(f"Expected latest previewed message to render first, got: {first_text!r}")
    first_expanded = first_text.split("Expanded resume history", 1)[1]
    if "previous question" in first_expanded:
        raise AssertionError(f"Did not expect older message in first expanded block, got: {first_text!r}")

    second_output = io.StringIO()
    cli._console.file = second_output
    cli._render_next_resume_message()
    second_text = second_output.getvalue()
    if "Expanded resume history: showing 2 most recent message(s)." not in second_text:
        raise AssertionError(f"Expected two expanded messages, got: {second_text!r}")
    second_expanded = second_text.split("Expanded resume history", 1)[1]
    previous_at = second_expanded.find("History 2/3 - user")
    latest_at = second_expanded.find("History 3/3 - assistant")
    if previous_at < 0 or latest_at < 0 or previous_at > latest_at:
        raise AssertionError(f"Expected older expanded message above newer message, got: {second_text!r}")
    if second_expanded.count("x") != 240:
        raise AssertionError(f"Expected full previous message content to render, got: {second_text!r}")
    if "..." in second_expanded:
        raise AssertionError(f"Did not expect expanded messages to be truncated, got: {second_text!r}")

    third_output = io.StringIO()
    cli._console.file = third_output
    cli._render_next_resume_message()
    third_text = third_output.getvalue()
    if "History 1/3 - user" not in third_text or "oldest question" not in third_text:
        raise AssertionError(f"Expected third expansion to include oldest message, got: {third_text!r}")

    exhausted_output = io.StringIO()
    cli._console.file = exhausted_output
    cli._render_next_resume_message()
    if "All resume history messages are already shown." not in exhausted_output.getvalue():
        raise AssertionError(f"Expected exhausted history notice, got: {exhausted_output.getvalue()!r}")


def test_chat_cli_resume_history_notice_without_visible_messages() -> None:
    cli = ChatCLI(runtime=None, session=None)
    cli._prepare_resume_history([{"role": "system", "content": "sys"}])
    output = io.StringIO()
    cli._console.file = output

    cli._render_next_resume_message()

    if "No resume history messages to show." not in output.getvalue():
        raise AssertionError(f"Expected no-history notice, got: {output.getvalue()!r}")


def test_chat_cli_seeds_input_history_from_user_messages() -> None:
    cli = ChatCLI(runtime=None, session=None)
    cli._seed_input_history(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "first question"},
            {"role": "user", "content": "second question"},
        ]
    )

    history = list(cli._input_history.get_strings())
    if history != ["first question", "second question"]:
        raise AssertionError(f"Expected distinct user inputs in history, got: {history!r}")


def test_chat_cli_input_bindings_include_clear_shortcut() -> None:
    cli = ChatCLI(runtime=None, session=None)
    keys = {tuple(binding.keys) for binding in cli._build_input_key_bindings().bindings}

    if ("c-l",) not in keys or ("c-o",) not in keys:
        raise AssertionError(f"Expected Ctrl+L/Ctrl+O key bindings, got: {keys!r}")
    if ("c-c",) not in keys or ("c-d",) not in keys:
        raise AssertionError(f"Expected input abort draft bindings, got: {keys!r}")


def test_chat_cli_clear_prompt_screen_clears_console() -> None:
    cli = ChatCLI(runtime=None, session=None)
    called = []
    cli._console.clear = lambda: called.append(True)

    cli._clear_prompt_screen()

    if called != [True]:
        raise AssertionError(f"Expected console.clear to be called once, got: {called!r}")


def test_chat_cli_saves_input_draft(tmp_path) -> None:
    class FakeSession:
        _session_paths = {"base": str(tmp_path / "session_1")}

    cli = ChatCLI(runtime=None, session=FakeSession())
    path = cli._save_input_draft("  long unfinished prompt  ")

    if path is None or path.name != "input_draft.txt":
        raise AssertionError(f"Expected draft path, got: {path!r}")
    if path.read_text(encoding="utf-8") != "long unfinished prompt":
        raise AssertionError(f"Expected trimmed draft content, got: {path.read_text(encoding='utf-8')!r}")
    if cli._last_input_draft_path != path:
        raise AssertionError(f"Expected latest draft path to be tracked, got: {cli._last_input_draft_path!r}")


def test_chat_cli_skips_empty_input_draft(tmp_path) -> None:
    class FakeSession:
        _session_paths = {"base": str(tmp_path / "session_1")}

    cli = ChatCLI(runtime=None, session=FakeSession())

    if cli._save_input_draft("  \n") is not None:
        raise AssertionError("Expected empty draft to be ignored")
    if (tmp_path / "session_1" / "input_draft.txt").exists():
        raise AssertionError("Did not expect empty draft file")


def test_chat_cli_renders_saved_draft_notice(tmp_path) -> None:
    cli = ChatCLI(runtime=None, session=None)
    output = io.StringIO()
    path = tmp_path / "input_draft.txt"
    cli._console.file = output
    cli._last_input_draft_path = path

    cli._render_saved_draft_notice()

    text = output.getvalue()
    if "Draft saved:" not in text or "input_draft.txt" not in text:
        raise AssertionError(f"Expected draft notice, got: {output.getvalue()!r}")
    if cli._last_input_draft_path is not None:
        raise AssertionError("Expected draft notice path to be cleared")


def test_chat_cli_uses_pending_input_prefill_once(monkeypatch) -> None:
    captured = {}

    class FakePromptSession:
        def __init__(self, **kwargs):
            pass

        def prompt(self, message, **kwargs):
            captured.setdefault("defaults", []).append(kwargs.get("default", ""))
            return kwargs.get("default", "")

    monkeypatch.setattr("agent.interfaces.cli.chat_cli.PromptSession", FakePromptSession)

    cli = ChatCLI(runtime=None, session=None)
    cli._pending_input_prefill = "continue this prompt"

    if cli._read_user_input() != "continue this prompt":
        raise AssertionError("Expected pending prefill to be returned")
    if cli._read_user_input() != "":
        raise AssertionError("Expected pending prefill to be consumed")
    if captured["defaults"] != ["continue this prompt", ""]:
        raise AssertionError(f"Expected one-shot defaults, got: {captured['defaults']!r}")


def test_chat_cli_installs_user_question_responder() -> None:
    captured = {}

    class FakeRuntime:
        def set_user_question_responder(self, responder):
            captured["responder"] = responder

    cli = ChatCLI(runtime=FakeRuntime(), session=None)

    if captured.get("responder") != cli._answer_user_question:
        raise AssertionError(f"Expected CLI responder to be installed, got: {captured!r}")


def test_chat_cli_user_question_resolves_numbered_option(monkeypatch) -> None:
    output = io.StringIO()
    captured = {}

    class FakePromptSession:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        def prompt(self, message, **kwargs):
            captured["message"] = message
            return "1"

    monkeypatch.setattr("agent.interfaces.cli.chat_cli.PromptSession", FakePromptSession)

    cli = ChatCLI(runtime=None, session=None)
    cli._console.file = output
    answer = cli._read_user_question_answer(
        UserQuestionRequestedEvent(
            question="Which mode?",
            options=["fast", "thorough"],
            recommended="fast",
        )
    )

    text = output.getvalue()
    if answer != "fast":
        raise AssertionError(f"Expected option 1 to resolve to first option, got: {answer!r}")
    if "Which mode?" not in text or "1. fast (recommended)" not in text or "2. thorough" not in text:
        raise AssertionError(f"Expected question UI with recommended option, got: {text!r}")
    if captured.get("message") != "Answer > ":
        raise AssertionError(f"Expected answer prompt label, got: {captured!r}")
    if not isinstance(captured.get("kwargs", {}).get("history"), InMemoryHistory):
        raise AssertionError(f"Expected responder prompt to have isolated history, got: {captured!r}")


def test_chat_cli_user_question_keeps_free_text_and_empty_answers() -> None:
    cli = ChatCLI(runtime=None, session=None)

    if cli._resolve_user_question_answer("custom answer", ["fast", "thorough"]) != "custom answer":
        raise AssertionError("Expected free text answer to be preserved")
    if cli._resolve_user_question_answer("  ", ["fast", "thorough"]) != "":
        raise AssertionError("Expected empty answer to remain empty for tool failure handling")


def test_chat_cli_user_question_keyboard_interrupt_reaches_tool_processor(monkeypatch) -> None:
    class FakePromptSession:
        def __init__(self, **kwargs):
            pass

        def prompt(self, message, **kwargs):
            raise KeyboardInterrupt

    monkeypatch.setattr("agent.interfaces.cli.chat_cli.PromptSession", FakePromptSession)

    cli = ChatCLI(runtime=None, session=None)
    try:
        cli._read_user_question_answer(UserQuestionRequestedEvent(question="Continue?"))
    except KeyboardInterrupt:
        return
    raise AssertionError("Expected KeyboardInterrupt to propagate to processor for structured failure")


def main() -> int:
    test_chat_cli_turn_failed_event_prints_error_field()
    test_chat_cli_tool_result_failed_uses_failed_status()
    test_chat_cli_banner_mentions_core_shortcuts()
    test_chat_cli_loads_latest_usage_from_session()
    test_chat_cli_prefers_assistant_usage_over_latest_request_usage()
    test_chat_cli_token_event_updates_latest_usage()
    test_chat_cli_expands_recent_resume_messages_in_chronological_order()
    test_chat_cli_resume_history_notice_without_visible_messages()
    test_chat_cli_seeds_input_history_from_user_messages()
    test_chat_cli_input_bindings_include_clear_shortcut()
    test_chat_cli_clear_prompt_screen_clears_console()
    print("ChatCLI event tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
