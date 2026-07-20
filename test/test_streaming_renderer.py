import io
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

from rich.console import Console

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.interfaces.cli.ui import StreamingRenderer


def test_plain_text_without_newline_renders_immediately() -> None:
    stdout_buffer = io.StringIO()
    console_buffer = io.StringIO()
    renderer = StreamingRenderer(Console(file=console_buffer, force_terminal=False, color_system=None))

    with redirect_stdout(stdout_buffer):
        renderer.append("好的，我来搜索今天的热点新闻。")

    if stdout_buffer.getvalue() != "好的，我来搜索今天的热点新闻。":
        raise AssertionError(f"Expected plain text to render immediately, got: {stdout_buffer.getvalue()!r}")
    if renderer._pending:
        raise AssertionError(f"Expected no pending plain text after immediate render, got: {renderer._pending!r}")


def test_markdown_without_newline_stays_buffered_until_flush() -> None:
    stdout_buffer = io.StringIO()
    console_buffer = io.StringIO()
    renderer = StreamingRenderer(Console(file=console_buffer, force_terminal=False, color_system=None))

    with redirect_stdout(stdout_buffer):
        renderer.append("**重点**")

    if stdout_buffer.getvalue():
        raise AssertionError(f"Did not expect markdown text on stdout before flush, got: {stdout_buffer.getvalue()!r}")
    if renderer._pending != "**重点**":
        raise AssertionError(f"Expected markdown to stay buffered, got: {renderer._pending!r}")

    renderer.flush()

    if "重点" not in console_buffer.getvalue():
        raise AssertionError(f"Expected markdown to render through console on flush, got: {console_buffer.getvalue()!r}")


def test_separate_assistant_plain_messages_end_with_newlines() -> None:
    stdout_buffer = io.StringIO()
    console_buffer = io.StringIO()
    renderer = StreamingRenderer(Console(file=console_buffer, force_terminal=False, color_system=None))

    with redirect_stdout(stdout_buffer):
        renderer.append("第一句说明")
        renderer.finish_message()
        renderer.append("第二句说明")
        renderer.finish_message()

    if stdout_buffer.getvalue() != "第一句说明\n第二句说明\n":
        raise AssertionError(
            "Expected assistant message boundaries to add exactly one newline, "
            f"got: {stdout_buffer.getvalue()!r}"
        )
    if console_buffer.getvalue():
        raise AssertionError(f"Did not expect plain text to route through console, got: {console_buffer.getvalue()!r}")


def test_markdown_message_boundary_uses_console_newline() -> None:
    stdout_buffer = io.StringIO()
    console_buffer = io.StringIO()
    renderer = StreamingRenderer(Console(file=console_buffer, force_terminal=False, color_system=None))

    with redirect_stdout(stdout_buffer):
        renderer.append("**重点**")
        renderer.finish_message()

    if stdout_buffer.getvalue():
        raise AssertionError(f"Did not expect markdown boundary output on stdout, got: {stdout_buffer.getvalue()!r}")
    if console_buffer.getvalue() != "重点\n":
        raise AssertionError(f"Expected markdown message to end with one console newline, got: {console_buffer.getvalue()!r}")


def test_code_block_renders_visible_fences() -> None:
    stdout_buffer = io.StringIO()
    console_buffer = io.StringIO()
    renderer = StreamingRenderer(Console(file=console_buffer, force_terminal=False, color_system=None))

    with redirect_stdout(stdout_buffer):
        renderer.append("```python\nprint('ok')\n```\n")

    text = console_buffer.getvalue()
    if "``` python" not in text or "print('ok')" not in text or text.rstrip().endswith("```") is False:
        raise AssertionError(f"Expected visible code fences and code content, got: {text!r}")


def main() -> int:
    test_plain_text_without_newline_renders_immediately()
    test_markdown_without_newline_stays_buffered_until_flush()
    test_separate_assistant_plain_messages_end_with_newlines()
    test_markdown_message_boundary_uses_console_newline()
    test_code_block_renders_visible_fences()
    print("Streaming renderer tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
