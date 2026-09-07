"""Classified failure copy: one honest line per failure class (openclaw's
failure-reply pattern).

``user_error_line`` maps an exception or a ``turn_failed`` event onto a single
Chinese line with a recovery hint.  Rules: never raw stacks or provider bodies
(only the message text, whitespace-collapsed), detail capped at
:data:`DETAIL_LIMIT` chars, and unknown failures degrade to a short sanitized
reason instead of leaking internals.
"""

from __future__ import annotations

DETAIL_LIMIT = 120

TIMEOUT_LINE = "⏱️ worker 响应超时，任务未完成。稍后重发即可；如反复出现请检查网络。"
RATE_LIMIT_LINE = "🚦 模型限流，请稍等片刻再试，或降低并发。"
AUTH_LINE = "🔑 API 鉴权/额度失败：请检查 .rind/settings.json 的 apiKey 或服务商控制台。"
OVERFLOW_LINE = "📚 上下文超限：回复 /compact 压缩后重试，或发 /new 开新会话。"
CANCELLED_LINE = "已停止。"
UNKNOWN_TEMPLATE = "⚠️ 任务失败（{detail}）。可回复 /status 查看状态或重试。"

# Detection order matters: cancelled before timeout ("request cancelled by
# timeout"), rate limit before auth ("429" vs "401" never collide, but quota
# phrasing overlaps billing).
_SIGNATURES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cancelled", ("cancelled", "canceled", "aborted", "已取消", "任务取消")),
    ("timeout", ("timeout", "timed out", "超时")),
    ("rate_limit", ("rate limit", "rate_limit", "ratelimit", "429", "too many requests", "限流", "请求过于频繁")),
    ("auth", ("401", "403", "unauthorized", "forbidden", "quota", "billing", "insufficient",
              "api key", "api_key", "apikey", "鉴权", "额度")),
    ("overflow", ("context length", "context_length", "context window", "maximum context",
                  "context overflow", "token limit", "too many tokens", "上下文超限", "上下文过长")),
)


def _source_text(source: object) -> str:
    """Flatten an exception or worker event into one lowercase haystack."""
    if isinstance(source, dict):
        parts = [str(source.get(key) or "") for key in ("error_type", "error", "message", "type")]
        return " ".join(part for part in parts if part)
    label = type(source).__name__ if isinstance(source, BaseException) else ""
    return " ".join(part for part in (label, str(source or "")) if part)


def _detail(text: str) -> str:
    """Whitespace-collapsed, size-capped reason for the unknown path."""
    collapsed = " ".join(str(text or "").split())
    if len(collapsed) > DETAIL_LIMIT:
        collapsed = collapsed[:DETAIL_LIMIT]
    return collapsed or "未知错误"


def user_error_line(source: object) -> str:
    """One user-facing line for ``source`` (exception or event dict)."""
    haystack = _source_text(source).lower()
    for kind, needles in _SIGNATURES:
        if any(needle in haystack for needle in needles):
            if kind == "cancelled":
                return CANCELLED_LINE
            if kind == "timeout":
                return TIMEOUT_LINE
            if kind == "rate_limit":
                return RATE_LIMIT_LINE
            if kind == "auth":
                return AUTH_LINE
            return OVERFLOW_LINE
    if isinstance(source, dict):
        raw = str(source.get("error") or source.get("error_type") or source.get("message") or "")
    else:
        raw = str(source or "")
    return UNKNOWN_TEMPLATE.format(detail=_detail(raw))


__all__ = [
    "AUTH_LINE",
    "CANCELLED_LINE",
    "DETAIL_LIMIT",
    "OVERFLOW_LINE",
    "RATE_LIMIT_LINE",
    "TIMEOUT_LINE",
    "UNKNOWN_TEMPLATE",
    "user_error_line",
]
