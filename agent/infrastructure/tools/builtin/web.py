"""Multi-engine web search and content extraction tools."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from agent.domain.cancellation import CancellationToken
from agent.domain import tool_cancelled, tool_error, tool_ok
from agent.infrastructure.tools.spec import ToolSpec


# ---------------------------------------------------------------------------
# HTTP session (curl_cffi with Chrome TLS fingerprint impersonation)
# ---------------------------------------------------------------------------

try:
    from curl_cffi import requests as cffi_requests

    _HAS_CFFI = True
except ImportError:
    import requests as cffi_requests  # type: ignore[no-redef]

    _HAS_CFFI = False

_SESSION = None
_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
_MAX_REDIRECTS = 5


def _cancelled(tool_name: str, token: CancellationToken | None) -> str | None:
    if token and token.is_cancelled:
        return tool_cancelled(tool_name, token.reason)
    return None


def _get_session():
    global _SESSION
    if _SESSION is None:
        kwargs: dict[str, Any] = {}
        if _HAS_CFFI:
            kwargs["impersonate"] = "chrome"
        _SESSION = cffi_requests.Session(**kwargs)
    return _SESSION


# ---------------------------------------------------------------------------
# Search engines
# ---------------------------------------------------------------------------

def _search_bing(query: str, max_results: int) -> list[dict[str, str]]:
    session = _get_session()
    url = "https://cn.bing.com/search"
    params = {"q": query, "count": max_results}
    headers = {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    }
    response = session.get(url, params=params, headers=headers, timeout=10)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    results: list[dict[str, str]] = []

    for item in soup.find_all("li", class_="b_algo", limit=max_results):
        title_tag = item.find("h2")
        if not title_tag:
            continue
        link_tag = title_tag.find("a")
        if not link_tag:
            continue

        title = link_tag.get_text(strip=True)
        link = link_tag.get("href", "")

        snippet = ""
        caption = item.find("div", class_="b_caption")
        if caption:
            p_tag = caption.find("p")
            if p_tag:
                snippet = p_tag.get_text(strip=True)

        if title and link:
            results.append({"title": title, "url": link, "snippet": snippet})

    return results


def _search_baidu(query: str, max_results: int) -> list[dict[str, str]]:
    session = _get_session()
    url = "https://www.baidu.com/s"
    params = {"wd": query, "rn": str(min(max_results, 10))}
    headers = {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    }
    response = session.get(url, params=params, headers=headers, timeout=10)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    results: list[dict[str, str]] = []

    for item in soup.find_all("div", class_="c-container", limit=max_results * 3):
        if len(results) >= max_results:
            break

        title_tag = item.find("h3")
        if not title_tag:
            continue
        link_tag = title_tag.find("a")
        if not link_tag:
            continue

        title = link_tag.get_text(strip=True)
        if not title:
            continue

        href = link_tag.get("href", "")

        # Resolve Baidu redirect URLs or skip internal links
        if not href or href.startswith("/"):
            mu = item.get("mu")
            if mu and mu.startswith("http"):
                href = mu
            else:
                continue
        elif "baidu.com/link" in href or "baidu.com/baidu.php" in href:
            mu = item.get("mu")
            if mu and mu.startswith("http"):
                href = mu

        snippet = ""
        for cls in ("c-abstract", "content-right_8Zs40", "c-span-last"):
            abstract = item.find(class_=cls)
            if abstract:
                snippet = abstract.get_text(strip=True)
                break
        if not snippet:
            for div in item.find_all("div"):
                text = div.get_text(strip=True)
                if len(text) > 20 and text != title:
                    snippet = text[:200]
                    break

        results.append({"title": title, "url": href, "snippet": snippet})

    return results


def _search_ddg(query: str, max_results: int) -> list[dict[str, str]]:
    session = _get_session()
    url = "https://html.duckduckgo.com/html/"
    headers = {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://html.duckduckgo.com/",
    }
    data = {"q": query}
    response = session.post(url, data=data, headers=headers, timeout=10)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    results: list[dict[str, str]] = []

    for result_div in soup.find_all("div", class_="result", limit=max_results):
        title_tag = result_div.find("a", class_="result__a")
        snippet_tag = result_div.find("a", class_="result__snippet")
        if title_tag:
            results.append({
                "title": title_tag.get_text(strip=True),
                "url": title_tag.get("href", ""),
                "snippet": snippet_tag.get_text(strip=True) if snippet_tag else "",
            })

    return results


# ---------------------------------------------------------------------------
# Public tool functions
# ---------------------------------------------------------------------------

def search_web(
    query: str,
    max_results: int = 5,
    _cancellation_token: CancellationToken | None = None,
) -> str:
    """
    Search the internet using multiple engines with automatic fallback (Bing -> Baidu -> DDG).
    Works reliably in mainland China.
    :param query: Search keywords (supports Chinese and English)
    :param max_results: Max number of results (default 5)
    """
    if cancelled := _cancelled("search_web", _cancellation_token):
        return cancelled
    query = str(query or "").strip()
    if not query:
        return tool_error("search_web", "query is required.", "ValidationError")
    max_results = _clamp_search_results(max_results)
    errors: list[str] = []

    # Detect Chinese characters in query to prioritize Baidu for Chinese content
    has_chinese = bool(re.search(r'[一-鿿]', query))
    engines = [
        ("baidu", _search_baidu),
        ("bing", _search_bing),
        ("ddg", _search_ddg),
    ] if has_chinese else [
        ("bing", _search_bing),
        ("baidu", _search_baidu),
        ("ddg", _search_ddg),
    ]

    for name, engine_fn in engines:
        if cancelled := _cancelled("search_web", _cancellation_token):
            return cancelled
        try:
            results = engine_fn(query, max_results)
            if cancelled := _cancelled("search_web", _cancellation_token):
                return cancelled
            if results:
                return tool_ok(
                    "search_web",
                    results,
                    meta={"engine": name, "query": query, "matches": len(results)},
                )
        except Exception as e:
            errors.append(f"{name}: {e}")
            continue

    return tool_ok(
        "search_web",
        [],
        meta={"engine": "none", "query": query, "errors": errors, "matches": 0},
    )


def _clamp_search_results(value) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 5
    return max(1, min(parsed, 10))


def fetch_web_page(url: str, _cancellation_token: CancellationToken | None = None) -> str:
    """
    Fetch a web page and extract its main content as Markdown.
    Automatically strips navigation, ads, footers, and other boilerplate.
    :param url: Target web page URL
    """
    try:
        if cancelled := _cancelled("fetch_web_page", _cancellation_token):
            return cancelled
        import trafilatura

        session = _get_session()

        # Keep download/parse memory bounded; extracted content is handled by ToolOutputStore later.
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        current_url = url
        response = None
        body = bytearray()
        for redirect_count in range(_MAX_REDIRECTS + 1):
            response = session.get(
                current_url,
                headers=headers,
                timeout=15,
                allow_redirects=False,
                stream=True,
            )
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
                if cancelled := _cancelled("fetch_web_page", _cancellation_token):
                    return cancelled
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
        if cancelled := _cancelled("fetch_web_page", _cancellation_token):
            return cancelled

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
        if cancelled := _cancelled("fetch_web_page", _cancellation_token):
            return cancelled

        if not content:
            content = trafilatura.extract(
                html,
                url=url,
                output_format="markdown",
                include_tables=True,
                favor_precision=False,
            )

        # Last resort: plain text via BS4
        if cancelled := _cancelled("fetch_web_page", _cancellation_token):
            return cancelled

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


TOOL_SPECS = (
    ToolSpec(
        name="search_web",
        handler=search_web,
        description="搜索互联网信息。支持多搜索引擎自动切换（Bing/Baidu/DDG），适用于中英文内容查询，中国大陆可用。",
        param_descriptions={"query": "搜索关键词（支持中英文）", "max_results": "最大结果数 (默认 5)"},
    ),
    ToolSpec(
        name="fetch_web_page",
        handler=fetch_web_page,
        description="抓取并提取网页主要内容（自动去除导航、广告等干扰，输出Markdown）。通常在 search_web 返回 URL 后使用。",
        param_descriptions={"url": "网页 URL"},
    ),
)
