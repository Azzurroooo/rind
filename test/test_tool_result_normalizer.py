import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import ToolResultNormalizer


class MemoryOutputStore:
    def __init__(self, root: Path):
        self.root = root
        self.calls: list[tuple[str, str]] = []

    async def write(self, session_id: str, call_id: str, content: str) -> str:
        self.calls.append((session_id, call_id))
        path = self.root / session_id / f"{call_id}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return str(path.resolve())


@pytest.mark.asyncio
async def test_small_output_reuses_stable_content_for_all_projections() -> None:
    result = await ToolResultNormalizer().normalize('{"ok": true, "tool": "bash", "data": "done"}')

    expected = '{"ok": true,"tool": "bash","data": "done"}'
    assert result.terminal_content == expected
    assert result.model_content == expected
    assert result.persisted_content == expected
    assert result.model_content_policy == {"truncated": False}


@pytest.mark.asyncio
async def test_large_output_uses_one_absolute_output_path(tmp_path: Path) -> None:
    source = json.dumps({"ok": True, "tool": "bash", "data": "head" + "a" * 100_000 + "tail"})
    store = MemoryOutputStore(tmp_path)

    result = await ToolResultNormalizer().normalize(
        source,
        tool_name="bash",
        output_store=store,
        session_id="session-a",
        call_id="call-1",
    )

    assert store.calls == [("session-a", "call-1")]
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    assert result.persisted_content == result.model_content
    payload = json.loads(result.model_content)
    assert payload["meta"]["truncated"] is True
    assert Path(payload["meta"]["output_path"]).is_absolute()
    assert "Output truncated." in payload["data"]
    assert "Use read_file or bash" in payload["data"]
    assert "a" * 100_000 in (tmp_path / "session-a" / "call-1.txt").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_existing_output_path_is_reused_without_duplicate_write() -> None:
    path = "C:/sessions/session-a/tool-output/call-1.txt"
    payload = {"ok": True, "tool": "bash", "data": "preview", "meta": {"truncated": True, "output_path": path}}

    result = await ToolResultNormalizer().normalize(payload, tool_name="bash")

    normalized = json.loads(result.model_content)
    assert normalized["meta"]["output_path"] == path
    assert "Output truncated." in normalized["data"]


@pytest.mark.asyncio
async def test_preview_respects_utf8_bytes_and_lines(tmp_path: Path) -> None:
    source = "\n".join("界" * 40 for _ in range(3000))
    result = await ToolResultNormalizer().normalize(
        source,
        tool_name="read_file",
        output_store=MemoryOutputStore(tmp_path),
        session_id="session-a",
        call_id="call-2",
    )
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    assert json.loads(result.model_content)["meta"]["total_lines"] == 3000


@pytest.mark.asyncio
async def test_large_read_preview_keeps_source_metadata_without_output_store(tmp_path: Path) -> None:
    source = json.dumps(
        {
            "ok": True,
            "tool": "read_file",
            "data": "界" * 30000,
            "meta": {
                "path": "C:/workspace/book.txt",
                "offset": 10,
                "limit": 1000,
                "next_offset": 1010,
                "encoding": "utf-8",
                "sha256": "abc123",
                "truncated": True,
            },
        },
        ensure_ascii=False,
    )
    store = MemoryOutputStore(tmp_path)

    result = await ToolResultNormalizer().normalize(
        source,
        tool_name="read_file",
        output_store=store,
        session_id="session-a",
        call_id="call-read",
    )

    assert store.calls == []
    assert len(result.model_content.encode("utf-8")) <= 25 * 1024
    payload = json.loads(result.model_content)
    assert payload["meta"]["path"] == "C:/workspace/book.txt"
    assert payload["meta"]["next_offset"] == 1010
    assert "output_path" not in payload["meta"]
    assert "original path and next_offset" in payload["data"]


@pytest.mark.asyncio
async def test_paginated_read_keeps_full_page_without_preview_truncation(tmp_path: Path) -> None:
    source = json.dumps(
        {
            "ok": True,
            "tool": "read_file",
            "data": "Showing lines 1 to 2:\n1 | first\n2 | second",
            "meta": {"path": "book.txt", "offset": 1, "limit": 2, "next_offset": 3, "truncated": True},
        },
        ensure_ascii=False,
    )

    result = await ToolResultNormalizer().normalize(source, tool_name="read_file", output_store=MemoryOutputStore(tmp_path))

    payload = json.loads(result.model_content)
    assert "1 | first" in payload["data"]
    assert "Read output is limited to the requested page" in payload["data"]


@pytest.mark.asyncio
async def test_error_payload_preserves_error_type() -> None:
    result = await ToolResultNormalizer().normalize(
        '{"tool": "bash", "ok": false, "error_type": "Timeout", "error": "too slow"}'
    )
    assert '"error_type": "Timeout"' in result.model_content
    assert '"error": "too slow"' in result.model_content


@pytest.mark.asyncio
async def test_stable_serialization_for_same_input() -> None:
    normalizer = ToolResultNormalizer()
    first = await normalizer.normalize({"z": 1, "tool": "bash", "ok": True, "data": {"b": 2, "a": 1}})
    second = await normalizer.normalize({"ok": True, "data": {"a": 1, "b": 2}, "z": 1, "tool": "bash"})
    assert first.model_content == second.model_content


@pytest.mark.asyncio
async def test_empty_bash_output_poll_is_compacted() -> None:
    result = await ToolResultNormalizer().normalize(
        {
            "ok": True,
            "tool": "bash_output",
            "data": {
                "bg_id": "bg_123",
                "status": "running",
                "stdout": "",
                "stderr": "",
                "no_new_output": True,
                "empty_observation_count": 4,
                "suggested_next_wait_ms": 30000,
            },
        }
    )
    assert '"bg_id": "bg_123"' in result.model_content
    assert '"status": "running"' in result.model_content
    assert '"no_new_output": true' in result.model_content
    assert "stdout" not in result.model_content
    assert "stderr" not in result.model_content
