# Web Tools: Search and Body Extraction Are Separate

English | [简体中文](web-tools.zh-CN.md)

search_web provides candidate links, and fetch_web_page extracts the page body. The two share the Worker's WebSessions, yet still reach the model through the ordinary tool result boundary.

~~~mermaid
flowchart TB
    Q["search query"] --> LANG{"contains Chinese?"}
    LANG -->|"yes"| B["Baidu → Bing → DDG"]
    LANG -->|"no"| E["Bing → Baidu → DDG"]
    B --> LINKS["the first engine with results"]
    E --> LINKS
    LINKS --> FETCH["fetch_web_page"]
    FETCH --> EXTRACT["trafilatura → relaxed extraction → BS4"]
    EXTRACT --> N["unified result normalization"]
~~~

The number of search results is limited to 1–10, with a default of 5. On failure, or when a given engine returns no results, the next engine is tried; when all engines return nothing, an empty list is returned and the engine errors are preserved in meta. This fallback improves availability, but it is not a guarantee of the real-time search success rate.

Fetching uses a streaming download bounded to a 10 MiB body, follows at most 5 redirects, and uses timeout=15 for a single HTTP request. trafilatura first precisely extracts Markdown including tables; on failure it drops precision, and finally BeautifulSoup strips script, navigation, and similar tags to extract the text. The long extracted body is then handed to the generic ToolResultNormalizer.

Web content is still external data, and does not become a trusted instruction just because it was converted to Markdown. Cancellation is checked at the download-chunk, redirect, and extraction stage boundaries; while a synchronous network call is waiting, the response speed is still constrained by the request timeout.

Code entry points: [search](../../../agent/infrastructure/tools/web/search.py), [fetch](../../../agent/infrastructure/tools/web/fetch.py), [session pool](../../../agent/infrastructure/tools/web/session_pool.py). Verification: [local web tool regression](../../../test/test_web_tool.py).

[Back to the series map](../README.md)
