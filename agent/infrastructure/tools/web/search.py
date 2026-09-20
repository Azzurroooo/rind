from __future__ import annotations

import re
from contextlib import closing
from bs4 import BeautifulSoup
from agent.domain.cancellation import CancellationToken
from agent.domain import tool_cancelled, tool_error, tool_ok
from .session_pool import WebSessions


def _search_bing(query: str, max_results: int, session) -> list[dict[str, str]]:
    url = "https://cn.bing.com/search"
    params = {"q": query, "count": max_results}
    headers = {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    }
    with closing(session.get(url, params=params, headers=headers, timeout=10)) as response:
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



def _search_baidu(query: str, max_results: int, session) -> list[dict[str, str]]:
    url = "https://www.baidu.com/s"
    params = {"wd": query, "rn": str(min(max_results, 10))}
    headers = {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    }
    with closing(session.get(url, params=params, headers=headers, timeout=10)) as response:
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



def _search_ddg(query: str, max_results: int, session) -> list[dict[str, str]]:
    url = "https://html.duckduckgo.com/html/"
    headers = {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://html.duckduckgo.com/",
    }
    data = {"q": query}
    with closing(session.post(url, data=data, headers=headers, timeout=10)) as response:
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



def search_web(
    query: str,
    max_results: int = 5,
    _cancellation_token: CancellationToken | None = None,
    *,
    _http_sessions: WebSessions,
) -> str:
    """
    Search the internet using multiple engines with automatic fallback (Bing -> Baidu -> DDG).
    Works reliably in mainland China.
    :param query: Search keywords (supports Chinese and English)
    :param max_results: Max number of results (default 5)
    """
    if _cancellation_token and _cancellation_token.is_cancelled:
        return tool_cancelled("search_web", _cancellation_token.reason)
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

    with _http_sessions.acquire() as session:
        for name, engine_fn in engines:
            if _cancellation_token and _cancellation_token.is_cancelled:
                return tool_cancelled("search_web", _cancellation_token.reason)
            try:
                results = engine_fn(query, max_results, session)
                if _cancellation_token and _cancellation_token.is_cancelled:
                    return tool_cancelled("search_web", _cancellation_token.reason)
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
