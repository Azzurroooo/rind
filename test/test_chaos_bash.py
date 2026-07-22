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
from agent.infrastructure.tools.builtin.shell.runner import _StreamCapture
from agent.infrastructure.tools.builtin.shell.tool import _RUNNER, bash


def _python_command(code: str) -> str:
    escaped_code = code.replace('"', '\\"')
    if os.name == "nt":
        return f'python -c "{escaped_code}"'
    executable = str(sys.executable).replace('"', '\\"')
    return f'"{executable}" -c "{escaped_code}"'


def run(coro):
    return asyncio.run(coro)


def test_bash_truncation_large_output(monkeypatch):
    res = run(bash(_python_command("print('A' * 50000)")))
    parsed = json.loads(res)

    assert parsed["ok"] is True
    assert parsed["tool"] == "bash"

    stdout = parsed["data"]["stdout"]

    assert len(stdout) <= 25000
    assert "TRUNCATED" in stdout
    assert stdout.startswith("A" * 100)
    assert stdout.strip().endswith("A" * 100)
    assert parsed["meta"] == {
        "truncated": True,
        "total_bytes": len(("A" * 50000 + os.linesep).encode()),
        "total_lines": 1,
    }


def test_stream_capture_discards_100_mib_without_growing_retained_text():
    capture = _StreamCapture()
    raw = b"A" * 4095 + b"\n"
    text = raw.decode()

    for _ in range((100 * 1024 * 1024) // len(raw)):
        capture.append(raw, text)

    assert capture.byte_count == 100 * 1024 * 1024
    assert capture.line_count == 25600
    assert capture.char_count == 100 * 1024 * 1024
    assert sum(map(len, capture.head)) == 10000
    assert capture.tail_chars == 10000
    assert len(capture.render()) < 21000
    assert capture.truncated is True

def test_bash_timeout(monkeypatch):
    """Test that a stuck process is killed after timeout."""
    # Temporarily reduce timeout for the test
    original_timeout = _RUNNER.timeout
    _RUNNER.timeout = 1

    try:
        # Sleep for 3 seconds, which exceeds the 1 second timeout
        res = run(bash(_python_command("import time; time.sleep(3)")))
        parsed = json.loads(res)

        assert parsed["ok"] is True
        assert "PROCESS TERMINATED: Command timed out" in parsed["data"]["stderr"]
    finally:
        _RUNNER.timeout = original_timeout


async def _run_cancelled_bash():
    source = CancellationTokenSource()

    async def cancel_soon():
        await asyncio.sleep(0.1)
        source.cancel("test interrupt")

    asyncio.create_task(cancel_soon())
    res = await bash(
        "python3 -c \"import time; time.sleep(3)\"",
        session_id="chaos_cancel",
        _cancellation_token=source.token,
    )
    pending = [
        task for task in asyncio.all_tasks()
        if task is not asyncio.current_task() and not task.done()
    ]
    return json.loads(res), pending


def test_bash_cancellation_settles_internal_tasks():
    parsed, pending = run(_run_cancelled_bash())

    assert parsed["ok"] is True
    assert "PROCESS TERMINATED: Command cancelled: test interrupt" in parsed["data"]["stderr"]
    assert pending == []


def main() -> int:
    test_bash_truncation_large_output(None)
    test_stream_capture_discards_100_mib_without_growing_retained_text()
    test_bash_timeout(None)
    test_bash_cancellation_settles_internal_tasks()
    print("Chaos bash tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
