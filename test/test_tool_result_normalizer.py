import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import ToolResultNormalizer


def test_small_output_reuses_stable_content_for_all_projections() -> None:
    normalizer = ToolResultNormalizer()

    result = normalizer.normalize('{"ok": true, "tool": "bash", "data": "done"}')

    expected = '{"ok": true,"tool": "bash","data": "done"}'
    assert result.terminal_content == expected
    assert result.model_content == expected
    assert result.persisted_content == expected
    assert result.model_content_policy == {"truncated": False}
    assert result.model_content_format == "tool_result_v2"


def test_projections_use_distinct_limits_and_preserve_head_tail() -> None:
    source = json.dumps({"ok": True, "tool": "bash", "data": "head" + "a" * 2000 + "tail"})
    normalizer = ToolResultNormalizer(
        terminal_max_bytes=400,
        persistence_max_bytes=800,
        max_chars=600,
        max_tokens=10000,
    )

    result = normalizer.normalize(source, tool_name="bash")

    assert len(result.terminal_content.encode("utf-8")) <= 400
    assert len(result.model_content) <= 600
    assert len(result.persisted_content.encode("utf-8")) <= 800
    assert len(result.terminal_content) < len(result.model_content) < len(result.persisted_content)
    for content in (result.terminal_content, result.model_content, result.persisted_content):
        payload = json.loads(content)
        assert payload["meta"] == {
            "truncated": True,
            "total_bytes": len(source.encode("utf-8")),
            "total_lines": 1,
        }
        assert "head" in payload["data"]
        assert "tail" in payload["data"]
        assert "tool_result_truncated" in payload["data"]
    assert result.model_content_policy == {
        "truncated": True,
        "total_bytes": len(source.encode("utf-8")),
        "total_lines": 1,
    }


def test_utf8_byte_limits_and_line_counts_are_exact() -> None:
    source = "第一行\n" + "界" * 1000 + "\n末行"
    normalizer = ToolResultNormalizer(
        terminal_max_bytes=512,
        persistence_max_bytes=768,
        max_chars=5000,
        max_tokens=10000,
    )

    result = normalizer.normalize(source, tool_name="read_file")

    terminal = json.loads(result.terminal_content)
    persisted = json.loads(result.persisted_content)
    assert len(result.terminal_content.encode("utf-8")) <= 512
    assert len(result.persisted_content.encode("utf-8")) <= 768
    assert terminal["meta"]["total_bytes"] == len(source.encode("utf-8"))
    assert terminal["meta"]["total_lines"] == 3
    assert persisted["meta"] == terminal["meta"]


def test_large_input_is_not_sent_whole_to_tokenizer() -> None:
    class BoundedTokenizer:
        def encode(self, text: str, disallowed_special=()):
            assert len(text) <= 40000
            return list(range(len(text) // 4))

    normalizer = ToolResultNormalizer()
    normalizer._tokenizer = BoundedTokenizer()

    result = normalizer.normalize("start\n" + "x" * (2 * 1024 * 1024) + "\nend", tool_name="bash")

    assert len(result.terminal_content.encode("utf-8")) <= 8 * 1024
    assert len(result.model_content) <= 40000
    assert len(result.persisted_content.encode("utf-8")) <= 64 * 1024


def test_error_payload_preserves_error_type() -> None:
    normalizer = ToolResultNormalizer()

    result = normalizer.normalize(
        '{"tool": "bash", "ok": false, "error_type": "Timeout", "error": "too slow"}'
    )

    assert '"error_type": "Timeout"' in result.model_content
    assert '"error": "too slow"' in result.model_content


def test_stable_serialization_for_same_input() -> None:
    normalizer = ToolResultNormalizer()
    payload = {"z": 1, "tool": "bash", "ok": True, "data": {"b": 2, "a": 1}}

    first = normalizer.normalize(payload)
    second = normalizer.normalize({"ok": True, "data": {"a": 1, "b": 2}, "z": 1, "tool": "bash"})

    assert first.model_content == second.model_content


def test_tool_result_normalizer_compresses_empty_bash_output_poll() -> None:
    normalizer = ToolResultNormalizer()
    payload = {
        "ok": True,
        "tool": "bash_output",
        "data": {
            "bg_id": "bg_123",
            "status": "running",
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
            "delta": True,
            "no_new_output": True,
            "sequence": 9,
            "wait_ms": 5000,
            "elapsed_ms": 5003,
            "truncated": False,
            "empty_observation_count": 4,
            "suggested_next_wait_ms": 30000,
            "timestamp": "2026-06-03T00:00:00Z",
        },
        "meta": {"truncated": False, "total_bytes": 0, "total_lines": 0},
    }

    result = normalizer.normalize(payload)

    assert '"bg_id": "bg_123"' in result.model_content
    assert '"status": "running"' in result.model_content
    assert '"no_new_output": true' in result.model_content
    assert '"suggested_next_wait_ms": 30000' in result.model_content
    assert '"total_bytes": 0' in result.model_content
    assert "stdout" not in result.model_content
    assert "stderr" not in result.model_content
    assert "timestamp" not in result.model_content
    assert "sequence" not in result.model_content
