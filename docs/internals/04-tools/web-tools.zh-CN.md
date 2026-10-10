# Web 工具：检索与正文提取分开

English | [简体中文](web-tools.md)

search_web 给出候选链接，fetch_web_page 提取页面正文。二者共享 Worker 的 WebSessions，仍通过普通工具结果边界进入模型。

~~~mermaid
flowchart TB
    Q["检索词"] --> LANG{"含中文？"}
    LANG -->|"是"| B["Baidu → Bing → DDG"]
    LANG -->|"否"| E["Bing → Baidu → DDG"]
    B --> LINKS["首个有结果的引擎"]
    E --> LINKS
    LINKS --> FETCH["fetch_web_page"]
    FETCH --> EXTRACT["trafilatura → 宽松提取 → BS4"]
    EXTRACT --> N["统一结果归一化"]
~~~

搜索结果数量限制在 1–10，默认 5。失败或无结果时尝试下一个引擎；全部无结果返回空列表，并在 meta 中保留引擎错误。这个回退提高可用性，却不是对实时搜索成功率的保证。

抓取用流式下载限制正文到 10 MiB，最多跟随 5 次重定向，单次 HTTP 请求 timeout=15。trafilatura 先精确提取含表格的 Markdown，失败再降低精度，最后用 BeautifulSoup 去除脚本、导航等标签提取文字。解析得到的长正文交给通用 ToolResultNormalizer 处理。

Web 内容仍是外部数据，不因为转成 Markdown 就变成可信指令。取消在下载块、重定向及提取阶段边界检查；同步网络调用正在等待时，响应速度仍受请求 timeout 约束。

代码入口：[搜索](../../../agent/infrastructure/tools/web/search.py)、[抓取](../../../agent/infrastructure/tools/web/fetch.py)、[会话池](../../../agent/infrastructure/tools/web/session_pool.py)。验证：[本地 Web 工具回归](../../../test/test_web_tool.py)。

[返回系列地图](../README.zh-CN.md)
