import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.services import ToolResultNormalizer


def test_small_output_is_not_truncated() -> None:
    normalizer = ToolResultNormalizer(max_chars=40000, max_tokens=10000)

    result = normalizer.normalize('{"ok": true, "tool": "bash", "data": "done"}')

    assert result.model_content == '{"ok": true,"tool": "bash","data": "done"}'
    assert result.model_content_policy["truncated"] is False
    assert result.model_content_format == "tool_result_v1"


def test_large_output_is_head_tail_truncated_with_marker() -> None:
    payload = {"ok": True, "tool": "bash", "data": "a" * 300}
    normalizer = ToolResultNormalizer(max_chars=120, max_tokens=10000)

    result = normalizer.normalize(payload)

    assert "tool_result_truncated" in result.model_content
    assert result.model_content_policy["truncated"] is True
    assert result.model_content.startswith('{"ok": true')


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
    normalizer = ToolResultNormalizer(max_chars=40000, max_tokens=10000)
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
    }

    result = normalizer.normalize(payload)

    assert '"bg_id": "bg_123"' in result.model_content
    assert '"status": "running"' in result.model_content
    assert '"no_new_output": true' in result.model_content
    assert '"suggested_next_wait_ms": 30000' in result.model_content
    assert "stdout" not in result.model_content
    assert "stderr" not in result.model_content
    assert "timestamp" not in result.model_content
    assert "sequence" not in result.model_content


def main() -> int:
    test_small_output_is_not_truncated()
    test_large_output_is_head_tail_truncated_with_marker()
    test_error_payload_preserves_error_type()
    test_stable_serialization_for_same_input()
    test_tool_result_normalizer_compresses_empty_bash_output_poll()
    print("ToolResultNormalizer tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
