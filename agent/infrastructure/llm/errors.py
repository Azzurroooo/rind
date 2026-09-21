"""Provider error classification without retaining echoed image payloads."""

from agent.domain.errors import ProviderError
from .images import redact_image_text


def provider_error(exc: Exception, code: str | None = None) -> ProviderError:
    if isinstance(exc, ProviderError):
        return exc
    text = redact_image_text(str(exc))
    http_status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if "context_length_exceeded" in text.lower() or "maximum context length" in text.lower():
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
