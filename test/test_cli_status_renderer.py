import io
import json
import os
import sys
from pathlib import Path

from rich.console import Console

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.events import (
    ContextBuiltEvent,
    SkillActivatedEvent,
    ToolCallStartedEvent,
    ToolProgressEvent,
    ToolRequestedEvent,
    ToolResultEvent,
    TokenStatsUpdatedEvent,
    TurnCompletedEvent,
)
from agent.interfaces.cli.status import CliStatusRenderer


def make_renderer(*, debug: bool = False):
    output = io.StringIO()
    console = Console(file=output, force_terminal=False, color_system=None, width=120)
    return CliStatusRenderer(console, debug=debug), output


def test_tool_lifecycle_completed_output() -> None:
    renderer, output = make_renderer()

    renderer.handle(ToolCallStartedEvent(tool_call_id="call_1", tool_name="bash"))
    renderer.handle(
        ToolResultEvent(
            tool_call_id="call_1",
            tool_name="bash",
            status="completed",
            duration_ms=1250,
        )
    )

    text = output.getvalue()
    if "Running bash" not in text:
        raise AssertionError(f"Expected started line, got: {text!r}")
    if "Tool: bash completed in 1.25s" not in text:
        raise AssertionError(f"Expected completed line, got: {text!r}")


def test_tool_requested_shows_bash_command_and_deduplicates_start() -> None:
    renderer, output = make_renderer()

    renderer.handle(ToolRequestedEvent(tool_call_id="call_1", tool_name="bash", args_preview='{"command":"pytest -q"}'))
    renderer.handle(ToolCallStartedEvent(tool_call_id="call_1", tool_name="bash"))

    text = output.getvalue()
    if "Running bash: pytest -q" not in text:
        raise AssertionError(f"Expected command summary, got: {text!r}")
    if text.count("Running bash") != 1:
        raise AssertionError(f"Expected requested/started dedupe, got: {text!r}")


def test_tool_requested_shows_file_path_summary() -> None:
    renderer, output = make_renderer()

    renderer.handle(
        ToolRequestedEvent(
            tool_call_id="call_1",
            tool_name="read_file",
            args_preview='{"file_path":"agent/interfaces/cli/chat_cli.py"}',
        )
    )

    text = output.getvalue()
    if "Running read_file: agent/interfaces/cli/chat_cli.py" not in text:
        raise AssertionError(f"Expected file path summary, got: {text!r}")


def test_tool_lifecycle_failed_output() -> None:
    renderer, output = make_renderer()

    renderer.handle(
        ToolResultEvent(
            tool_call_id="call_1",
            tool_name="bash",
            status="failed",
            error_type="ToolExecutionError",
            duration_ms=50,
        )
    )

    text = output.getvalue()
    if "Tool: bash failed in 50ms (ToolExecutionError)" not in text:
        raise AssertionError(f"Expected failed line, got: {text!r}")


def test_tool_failed_output_includes_error_detail() -> None:
    renderer, output = make_renderer()

    renderer.handle(
        ToolResultEvent(
            tool_call_id="call_1",
            tool_name="bash",
            status="failed",
            error_type="ToolExecutionError",
            result=json.dumps({"ok": False, "tool": "bash", "error": "command not found"}),
            duration_ms=50,
        )
    )

    text = output.getvalue()
    if "Tool: bash failed in 50ms (ToolExecutionError): command not found" not in text:
        raise AssertionError(f"Expected failed detail line, got: {text!r}")


def test_skill_activation_deduplicates_within_turn() -> None:
    renderer, output = make_renderer()

    event = SkillActivatedEvent(skill_name="poem-writer", reason="explicit_dollar_name")
    renderer.handle(event)
    renderer.handle(event)

    text = output.getvalue()
    if text.count("Skill: poem-writer") != 1:
        raise AssertionError(f"Expected one skill line, got: {text!r}")


def test_context_built_is_quiet_in_normal_mode() -> None:
    renderer, output = make_renderer()

    event = ContextBuiltEvent(message_count=8, stats={"estimated_input_tokens": 1234})
    renderer.handle(event)
    renderer.handle(event)

    if output.getvalue():
        raise AssertionError(f"Expected no context output, got: {output.getvalue()!r}")


def test_context_built_is_quiet_in_debug_mode() -> None:
    renderer, output = make_renderer(debug=True)

    renderer.handle(ContextBuiltEvent(message_count=8, stats={"estimated_input_tokens": 1234}))

    if output.getvalue():
        raise AssertionError(f"Expected no debug context output, got: {output.getvalue()!r}")


def test_context_built_warns_on_tangerine_truncation() -> None:
    renderer, output = make_renderer()

    renderer.handle(
        ContextBuiltEvent(
            message_count=8,
            decisions={
                "tangerine_docs_truncated": True,
                "tangerine_docs_truncated_scopes": ["user", "project"],
            },
        )
    )

    text = output.getvalue()
    if "Warning: TANGERINE.md truncated for context: user, project" not in text:
        raise AssertionError(f"Expected TANGERINE truncation warning, got: {text!r}")


def test_token_stats_updated_output() -> None:
    renderer, output = make_renderer()

    renderer.handle(
        TokenStatsUpdatedEvent(
            stats={
                "input_tokens": 121300,
                "context_window_tokens": 258400,
                "context_usage_percent": 121300 / 258400,
                "cached_input_tokens": 98700,
                "cache_hit_rate": 98700 / 121300,
                "output_tokens": 2100,
            }
        )
    )

    text = output.getvalue()
    if "Tokens: input 121.3k / 258.4k" not in text:
        raise AssertionError(f"Expected input token line, got: {text!r}")
    if "cached 98.7k (81.4%)" not in text:
        raise AssertionError(f"Expected cache hit line, got: {text!r}")


def test_token_stats_tolerates_invalid_numeric_values() -> None:
    renderer, output = make_renderer()

    renderer.handle(
        TokenStatsUpdatedEvent(
            stats={
                "input_tokens": "bad",
                "context_window_tokens": object(),
                "cached_input_tokens": -1,
                "output_tokens": None,
                "context_usage_percent": "bad",
                "cache_hit_rate": None,
            }
        )
    )

    text = output.getvalue()
    if "Tokens: input 0 (0.0%), cached 0 (0.0%), output 0" not in text:
        raise AssertionError(f"Expected safe fallback token line, got: {text!r}")


def test_debug_tool_requested_shows_truncated_args() -> None:
    renderer, output = make_renderer(debug=True)
    args = '{"command":"' + ("x" * 600) + '"}'

    renderer.handle(ToolRequestedEvent(tool_call_id="call_1", tool_name="bash", args_preview=args))

    text = output.getvalue()
    if "[debug] tool requested: bash id=call_1" not in text or "args=" not in text:
        raise AssertionError(f"Expected debug requested line, got: {text!r}")
    if len(text) >= 520:
        raise AssertionError(f"Expected truncated args output, got length {len(text)}")


def test_tool_progress_deduplicates_messages() -> None:
    renderer, output = make_renderer()
    event = ToolProgressEvent(tool_call_id="call_1", tool_name="bash", payload={"message": "running"})

    renderer.handle(event)
    renderer.handle(event)

    text = output.getvalue()
    if text.count("Tool: bash running") != 1:
        raise AssertionError(f"Expected one progress line, got: {text!r}")


def test_turn_completed_summarizes_tool_counts() -> None:
    renderer, output = make_renderer()

    renderer.handle(ToolResultEvent(tool_call_id="ok", tool_name="read_file", status="completed"))
    renderer.handle(ToolResultEvent(tool_call_id="bad", tool_name="bash", status="failed"))
    renderer.handle(TurnCompletedEvent(duration_ms=2000))

    text = output.getvalue()
    if "Done in 2.00s - tools 1 completed, 1 failed" not in text:
        raise AssertionError(f"Expected turn summary, got: {text!r}")


def test_plain_turn_completed_without_tools_is_quiet() -> None:
    renderer, output = make_renderer()

    renderer.handle(TurnCompletedEvent(duration_ms=2000))

    if output.getvalue():
        raise AssertionError(f"Expected no output for tool-less normal turn, got: {output.getvalue()!r}")


def main() -> int:
    test_tool_lifecycle_completed_output()
    test_tool_requested_shows_bash_command_and_deduplicates_start()
    test_tool_requested_shows_file_path_summary()
    test_tool_lifecycle_failed_output()
    test_tool_failed_output_includes_error_detail()
    test_skill_activation_deduplicates_within_turn()
    test_context_built_is_quiet_in_normal_mode()
    test_context_built_is_quiet_in_debug_mode()
    test_context_built_warns_on_tangerine_truncation()
    test_token_stats_updated_output()
    test_token_stats_tolerates_invalid_numeric_values()
    test_debug_tool_requested_shows_truncated_args()
    test_tool_progress_deduplicates_messages()
    test_turn_completed_summarizes_tool_counts()
    test_plain_turn_completed_without_tools_is_quiet()
    print("CLI status renderer tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
