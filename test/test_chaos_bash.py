import json
import os
import sys
import asyncio
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.tools.shell.capture import StreamCapture


def _python_command(code: str) -> str:
    escaped_code = code.replace('"', '\\"')
    if os.name == "nt":
        return f'python -c "{escaped_code}"'
    executable = str(sys.executable).replace('"', '\\"')
    return f'"{executable}" -c "{escaped_code}"'


def run(coro):
    return asyncio.run(coro)


def test_bash_truncation_large_output(shell_tools, monkeypatch):
    res = run(shell_tools.bash(_python_command("print('A' * 60000)")))
    parsed = json.loads(res)

    assert parsed["ok"] is True
    assert parsed["tool"] == "bash"

    stdout = parsed["data"]["stdout"]

    assert len(stdout) <= 50 * 1024
    assert "TRUNCATED" in stdout
    assert stdout.startswith("A" * 100)
    assert stdout.strip().endswith("A" * 100)
    assert parsed["meta"]["truncated"] is True
    assert parsed["meta"]["total_bytes"] == len(("A" * 60000 + os.linesep).encode())
    assert Path(parsed["meta"]["output_path"]).is_file()
    assert len(Path(parsed["meta"]["output_path"]).read_bytes()) == parsed["meta"]["total_bytes"]


def test_stream_capture_discards_100_mib_without_growing_retained_text():
    capture = StreamCapture()
    raw = b"A" * 4095 + b"\n"
    text = raw.decode()

    for _ in range((100 * 1024 * 1024) // len(raw)):
        capture.append(raw, text)

    assert capture.byte_count == 100 * 1024 * 1024
    assert capture.line_count == 25600
    assert capture.char_count == 100 * 1024 * 1024
    assert sum(map(len, capture.head)) == 24 * 1024
    assert capture.tail_chars == 24 * 1024
    assert len(capture.render()) < 52 * 1024
    assert capture.truncated is True


def test_stream_capture_delta_survives_tail_rollover():
    capture = StreamCapture()
    capture.append(b"A" * 30000, "A" * 30000)
    capture.append(b"B" * 40000, "B" * 40000)

    _, cursor, truncated = capture.delta(0, 40000)
    capture.append(b"C" * 1000, "C" * 1000)
    delta, next_cursor, next_truncated = capture.delta(cursor, 40000)

    assert truncated is True
    assert delta == "C" * 1000
    assert next_cursor == 71000
    assert next_truncated is False

def test_bash_timeout(shell_tools, monkeypatch):
    """Test that a stuck process is killed after timeout."""
    # Temporarily reduce timeout for the test
    original_timeout = shell_tools.supervisor.timeout
    shell_tools.supervisor.timeout = 1

    try:
        # Sleep for 3 seconds, which exceeds the 1 second timeout
        res = run(shell_tools.bash(_python_command("import time; time.sleep(3)")))
        parsed = json.loads(res)

        assert parsed["ok"] is True
        assert "PROCESS TERMINATED: Command timed out" in parsed["data"]["stderr"]
    finally:
        shell_tools.supervisor.timeout = original_timeout


async def _run_cancelled_bash(shell_tools):
    source = CancellationTokenSource()

    async def cancel_soon():
        await asyncio.sleep(0.1)
        source.cancel("test interrupt")

    asyncio.create_task(cancel_soon())
    res = await shell_tools.bash(
        _python_command("import time; time.sleep(3)"),
        _session_id="chaos_cancel",
        _cancellation_token=source.token,
    )
    pending = [
        task for task in asyncio.all_tasks()
        if task is not asyncio.current_task() and not task.done()
    ]
    return json.loads(res), pending


def test_bash_cancellation_settles_internal_tasks(shell_tools):
    parsed, pending = run(_run_cancelled_bash(shell_tools))

    assert parsed["ok"] is True
    assert "PROCESS TERMINATED: Command cancelled: test interrupt" in parsed["data"]["stderr"]
    assert pending == []
