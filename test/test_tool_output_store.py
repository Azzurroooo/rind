import os
import time
from pathlib import Path

import pytest

from agent.infrastructure.persistence import ToolOutputStore


@pytest.mark.asyncio
async def test_tool_output_store_writes_absolute_session_path(tmp_path: Path) -> None:
    store = ToolOutputStore(str(tmp_path))

    output_path = await store.write("session-a", "call-1", "full output")

    path = Path(output_path)
    assert path.is_absolute()
    assert path == (tmp_path / "session-a" / "tool-output" / "call-1.txt").resolve()
    assert path.read_text(encoding="utf-8") == "full output"


@pytest.mark.asyncio
async def test_tool_output_store_cleans_expired_files(tmp_path: Path) -> None:
    store = ToolOutputStore(str(tmp_path), retention_seconds=1)
    output_path = Path(await store.write("session-a", "call-1", "old"))
    old = time.time() - 10
    os.utime(output_path, (old, old))

    await store.cleanup()

    assert not output_path.exists()
