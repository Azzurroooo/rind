import json
import os
import sys
import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools.impl.tools.bash import bash, _RUNNER


def _python_command(code: str) -> str:
    escaped_code = code.replace('"', '\\"')
    if os.name == "nt":
        return f'python -c "{escaped_code}"'
    executable = str(sys.executable).replace('"', '\\"')
    return f'"{executable}" -c "{escaped_code}"'
from agent.application.runtime.cancellation import CancellationTokenSource


def run(coro):
    return asyncio.run(coro)


def test_bash_truncation_large_output(monkeypatch):
    """
    Step 5.1: Chaos Engineering Test for Bash Tool
    Simulate a bash command outputting 50,000 characters and assert it truncates correctly without OOM.
    """
    # 模拟一个疯狂输出日志的命令
    res = run(bash(_python_command("print('A' * 50000)")))
    parsed = json.loads(res)

    assert parsed["ok"] is True
    assert parsed["tool"] == "bash"

    stdout = parsed["data"]["stdout"]

    # 我们不再直接检查 content 的截断标记，而是利用 _build_tool_content 的结果，
    # 或者直接检查被我们重写后的工具返回
    assert len(stdout) <= 25000
    assert "TRUNCATED" in stdout

    # 验证头尾数据被正确保留
    # Since python's print adds a newline, we should account for it.
    # The output from bash includes the stdout.
    assert stdout.startswith("A" * 100)
    assert stdout.strip().endswith("A" * 100)

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
    test_bash_timeout(None)
    test_bash_cancellation_settles_internal_tasks()
    print("Chaos bash tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
