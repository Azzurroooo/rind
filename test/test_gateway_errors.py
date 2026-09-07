"""user_error_line classification tests: every class → its copy line.

Covers the exception path (class names + messages), the turn_failed event-dict
path, detection precedence, the 120-char detail cap, and the sanitized unknown
path (no raw stacks, no provider bodies, no newlines).
"""

import asyncio
import os
import sys
from pathlib import Path

from gateway.errors import (
    AUTH_LINE,
    CANCELLED_LINE,
    DETAIL_LIMIT,
    OVERFLOW_LINE,
    RATE_LIMIT_LINE,
    TIMEOUT_LINE,
    UNKNOWN_TEMPLATE,
    user_error_line,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway.worker_client import WorkerRequestError, WorkerTimeout  # noqa: E402


def test_timeout_via_exception_and_event():
    assert user_error_line(WorkerTimeout("worker request timed out: session/prompt")) == TIMEOUT_LINE
    assert user_error_line(TimeoutError()) == TIMEOUT_LINE
    assert user_error_line({"type": "turn_failed", "error": "LLM request timed out after 300s"}) == TIMEOUT_LINE
    assert user_error_line({"error_type": "TimeoutError", "error": "上游 60s 无响应"}) == TIMEOUT_LINE


def test_rate_limit_detection():
    assert user_error_line({"error": "429 Too Many Requests"}) == RATE_LIMIT_LINE
    assert user_error_line(RuntimeError("Rate limit exceeded for org")) == RATE_LIMIT_LINE
    assert user_error_line({"error_type": "RateLimitError", "message": "请求过于频繁"}) == RATE_LIMIT_LINE


def test_auth_and_billing_detection():
    assert user_error_line({"error": "401 Unauthorized"}) == AUTH_LINE
    assert user_error_line({"error": "403 Forbidden"}) == AUTH_LINE
    assert user_error_line(RuntimeError("insufficient_quota: billing hard limit reached")) == AUTH_LINE
    assert user_error_line({"error_type": "AuthError", "message": "invalid api key provided"}) == AUTH_LINE


def test_context_overflow_detection():
    assert user_error_line({"error": "This model's maximum context length is 128000 tokens"}) == OVERFLOW_LINE
    assert user_error_line(RuntimeError("context_length_exceeded: 200k tokens")) == OVERFLOW_LINE
    assert user_error_line({"message": "上下文过长，无法继续"}) == OVERFLOW_LINE


def test_cancelled_detection():
    assert user_error_line(asyncio.CancelledError()) == CANCELLED_LINE
    assert user_error_line({"error": "request cancelled by user"}) == CANCELLED_LINE
    assert user_error_line(RuntimeError("turn aborted")) == CANCELLED_LINE


def test_unknown_path_uses_sanitized_short_reason():
    event = {"type": "turn_failed", "error": "模型\n连接 中断"}
    assert user_error_line(event) == "⚠️ 任务失败（模型 连接 中断）。可回复 /status 查看状态或重试。"
    assert user_error_line(RuntimeError("weird upstream state")) == (
        "⚠️ 任务失败（weird upstream state）。可回复 /status 查看状态或重试。")
    assert user_error_line({"error": ""}) == UNKNOWN_TEMPLATE.format(detail="未知错误")


def test_detail_is_capped_and_never_multiline():
    body = "x" * 400 + "\n" + "y" * 400
    line = user_error_line(RuntimeError(body))
    assert "x" * (DETAIL_LIMIT + 1) not in line
    assert "\n" not in line
    assert len(line) < 200
    event_line = user_error_line({"error": "y" * 500})
    assert "y" * (DETAIL_LIMIT + 1) not in event_line


def test_no_stack_or_provider_body_leakage():
    try:
        raise ValueError("secret-internal-detail")
    except ValueError as exc:
        line = user_error_line(exc)
    assert "secret-internal-detail" in line  # the message is the short reason
    assert "Traceback" not in line and "File \"" not in line
    assert line.startswith("⚠️") and line.endswith("。")


def test_worker_request_error_maps_by_provider_error_body():
    exc = WorkerRequestError("session/prompt", {"message": "Rate limit reached"})
    assert user_error_line(exc) == RATE_LIMIT_LINE
    exc = WorkerRequestError("session/prompt", {"message": "quota exceeded"})
    assert user_error_line(exc) == AUTH_LINE
