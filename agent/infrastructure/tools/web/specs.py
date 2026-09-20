from __future__ import annotations

from agent.domain.cancellation import CancellationToken
from agent.infrastructure.tools.spec import ToolSpec

from .fetch import fetch_web_page
from .search import search_web
from .session_pool import WebSessions


def build_web_tool_specs(http_sessions: WebSessions) -> tuple[ToolSpec, ...]:
    def search(query: str, max_results: int = 5, _cancellation_token: CancellationToken | None = None) -> str:
        return search_web(query, max_results, _cancellation_token, _http_sessions=http_sessions)

    def fetch(url: str, _cancellation_token: CancellationToken | None = None) -> str:
        return fetch_web_page(url, _cancellation_token, _http_sessions=http_sessions)

    return (
        ToolSpec(
            name="search_web",
            handler=search,
            description="Search the internet. Automatically switches between search engines (Bing/Baidu/DDG); works for both English and Chinese queries and is reachable from mainland China.",
            param_descriptions={"query": "Search keywords (English or Chinese)", "max_results": "Maximum number of results (default 5)"},
        ),
        ToolSpec(
            name="fetch_web_page",
            handler=fetch,
            description="Fetch a web page and extract its main content (navigation, ads, and other clutter removed; outputs Markdown). Typically used after search_web returns URLs.",
            param_descriptions={"url": "Web page URL"},
        ),
    )
