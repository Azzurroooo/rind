from __future__ import annotations

import re
from contextlib import closing
from bs4 import BeautifulSoup
from agent.domain.cancellation import CancellationToken
from agent.domain import tool_cancelled, tool_error, tool_ok
from .session_pool import WebSessions


from urllib.parse import urljoin

_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
_MAX_REDIRECTS = 5


def fetch_web_page(
    url: str, _cancellation_token: CancellationToken | None = None, *, _http_sessions: WebSessions,
) -> str:
    """
    Fetch a web page and extract its main content as Markdown.
    Automatically strips navigation, ads, footers, and other boilerplate.
    :param url: Target web page URL
    """
    try:
        if _cancellation_token and _cancellation_token.is_cancelled:
            return tool_cancelled("fetch_web_page", _cancellation_token.reason)
        import trafilatura


        # Keep download/parse memory bounded; extracted content is handled by ToolOutputStore later.
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        with _http_sessions.acquire() as session:
            current_url = url
            response = None
            body = bytearray()
            for redirect_count in range(_MAX_REDIRECTS + 1):
                if _cancellation_token and _cancellation_token.is_cancelled:
                    return tool_cancelled("fetch_web_page", _cancellation_token.reason)
                with closing(session.get(
                    current_url,
                    headers=headers,
                    timeout=15,
                    allow_redirects=False,
                    stream=True,
                )) as response:
                    if 300 <= response.status_code < 400:
                        location = response.headers.get("location")
                        if not location or redirect_count >= _MAX_REDIRECTS:
                            return tool_error("fetch_web_page", "Too many redirects", "TooManyRedirects", meta={"url": url})
                        current_url = urljoin(current_url, location)
                        continue
                    response.raise_for_status()
                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > _MAX_RESPONSE_BYTES:
                        return tool_error(
                            "fetch_web_page",
                            "Response body exceeds the 10 MiB network limit.",
                            "ResponseTooLarge",
                            meta={"url": url, "max_bytes": _MAX_RESPONSE_BYTES},
                        )
                    for chunk in response.iter_content(chunk_size=64 * 1024):
                        if _cancellation_token and _cancellation_token.is_cancelled:
                            return tool_cancelled("fetch_web_page", _cancellation_token.reason)
                        body.extend(chunk)
                        if len(body) > _MAX_RESPONSE_BYTES:
                            return tool_error(
                                "fetch_web_page",
                                "Response body exceeds the 10 MiB network limit.",
                                "ResponseTooLarge",
                                meta={"url": url, "max_bytes": _MAX_RESPONSE_BYTES},
                            )
                    break
        if response is None:
            return tool_error("fetch_web_page", "Unable to fetch response", "FetchError", meta={"url": url})
        if _cancellation_token and _cancellation_token.is_cancelled:
            return tool_cancelled("fetch_web_page", _cancellation_token.reason)

        encoding = getattr(response, "encoding", None) or "utf-8"
        html = bytes(body).decode(encoding, errors="replace")
        if not html:
            return tool_error("fetch_web_page", "Empty response from server", "EmptyResponse", meta={"url": url})

        # trafilatura extraction: prefer precision, include tables
        content = trafilatura.extract(
            html,
            url=url,
            output_format="markdown",
            include_tables=True,
            favor_precision=True,
        )

        # Fallback: lower precision
        if _cancellation_token and _cancellation_token.is_cancelled:
            return tool_cancelled("fetch_web_page", _cancellation_token.reason)

        if not content:
            content = trafilatura.extract(
                html,
                url=url,
                output_format="markdown",
                include_tables=True,
                favor_precision=False,
            )

        # Last resort: plain text via BS4
        if _cancellation_token and _cancellation_token.is_cancelled:
            return tool_cancelled("fetch_web_page", _cancellation_token.reason)

        if not content:
            soup = BeautifulSoup(html, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            content = soup.get_text(separator="\n")

        # Clean up excessive blank lines
        content = re.sub(r"\n{3,}", "\n\n", content.strip())

        return tool_ok(
            "fetch_web_page",
            content,
            meta={"url": url},
        )

    except Exception as e:
        return tool_error("fetch_web_page", f"Fetch error: {e}", type(e).__name__, meta={"url": url})
