"""Provider error classification without retaining echoed image payloads."""

import re

from agent.domain.errors import ProviderError
from .images import redact_image_text

_OVERFLOW_RE = re.compile(
    r"prompt is too long|"
    r"input is too long for requested model|"
    r"exceeds the context window|"
    r"input token count.*exceeds the maximum|"
    r"maximum prompt length is \d+|"
    r"reduce the length of the messages|"
    r"maximum context length|"
    r"exceeds the limit of \d+|"
    r"exceeds the available context size|"
    r"greater than the context length|"
    r"context window exceeds limit|"
    r"exceeded model token limit|"
    r"context length of only \d+|"
    r"context[_ ]length[_ ]exceeded|"
    r"context_overflow|"
    r"request_too_large|"
    r"too many tokens|"
    r"token limit exceeded",
    re.IGNORECASE | re.DOTALL,
)

_NON_OVERFLOW_RE = re.compile(
    r"too many tokens,\s*please wait|"
    r"tokens per minute|"
    r"rate[_ ]limit",
    re.IGNORECASE,
)


def is_context_overflow(text: str, http_status: int | None = None) -> bool:
    if _NON_OVERFLOW_RE.search(text):
        return False
    if _OVERFLOW_RE.search(text):
        return True
    return http_status == 413


def provider_error(exc: Exception, code: str | None = None) -> ProviderError:
    if isinstance(exc, ProviderError):
        if exc.code != "context_length_exceeded" and is_context_overflow(str(exc)):
            return ProviderError(str(exc), status="rejected", error_type=exc.error_type, code="context_length_exceeded")
        return exc
    text = redact_image_text(str(exc))
    http_status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if is_context_overflow(text, http_status if isinstance(http_status, int) else None):
        status, code = "rejected", "context_length_exceeded"
    elif http_status in {408, 504} or isinstance(exc, TimeoutError) or "Timeout" in type(exc).__name__:
        status = "timed_out"
    elif isinstance(http_status, int) and 400 <= http_status < 500 and http_status != 429:
        status, code = "rejected", "provider_rejected"
    elif isinstance(http_status, int) and http_status >= 500 or http_status == 429 or "Connection" in type(exc).__name__:
        status = "unavailable"
    else:
        status = "unavailable" if code == "stream_interrupted" else "failed"
    return ProviderError(text, status=status, error_type=type(exc).__name__, code=code)

