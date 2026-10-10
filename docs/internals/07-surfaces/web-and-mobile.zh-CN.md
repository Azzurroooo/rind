# Web 与 Mobile：共享 Surface，替换平台能力

English | [简体中文](web-and-mobile.md)

Web Surface 使用 React/Vite 和一个可重连的 WebSocket runtime client。Mobile 复用同一套 React 组件，通过 `SurfacePlatform` 注入 Capacitor 能力：安全存储、扫码、系统生命周期、原生 HTTP 与分享。

~~~mermaid
flowchart LR
    UI["共享 React Surface"] --> P["SurfacePlatform"]
    P --> B["浏览器：fetch + sessionStorage"]
    P --> N["Mobile：Capacitor secure storage / native HTTP"]
    B & N --> T["ticket / credential provider"]
    T --> WS["WebSocket runtime client"]
    WS --> W["Worker app-server --web 或 Desktop Gateway"]
~~~

client 为请求分配 request_id，区分 event 与 response；连接建立后每 10 秒 ping，25 秒没有存活信号就关闭。断线按 500ms 起步、最多 8 秒的退避重连，未完成请求被拒绝；401/403 或 4401 进入 unauthorized，不盲目重试。长请求（prompt、compact、command）默认 15 分钟，普通请求 30 秒。

Web 的 ticket 存在 sessionStorage；移动端通过原生 ticketFetch 禁止重定向，要求 HTTPS（本地配对地址除外）并使用有限超时。Desktop Gateway 的一次性 ticket 有 60 秒有效期，WebSocket 连接数和订阅数都有上限；Origin 只是来源校验，仍必须消费 ticket。

Mobile 不运行 Python、模型或 shell；它是远程 Surface。前端配置的 Worker 地址必须是显式 ws/wss URL，不能携带用户名、密码、query 或 hash，避免把旧链接当成隐式重定向。

## 两种远程入口

Desktop 远程访问直接复用其存活 Worker；独立部署则运行 Python app-server --web，浏览器关闭后服务继续存活。连接恢复后上层重新初始化、订阅并结合历史光标恢复视图，客户端不会自动重新发送所有失败请求，以免重复副作用。见[重放](../01-runtime/replay-and-resubscribe.zh-CN.md)。

独立 Docker 部署在仓库根目录的 .env 中设置：

~~~dotenv
RIND_SERVER_TOKEN=replace-with-a-long-random-token
RIND_WORKSPACE=/absolute/path/to/project
RIND_HOME=/absolute/path/to/rind-data
~~~

将供应商 settings.json 放入选定数据目录，再执行 `docker compose up -d --build`，访问 http://localhost:8080。Compose 强制要求 RIND_SERVER_TOKEN，默认浏览器入口只绑定 127.0.0.1。RIND_WEB_PORT、RIND_WEB_BIND 可改变入口；公网使用需配套 TLS 代理。

Mobile 的开发构建、原生平台前置条件见 [mobile/README](../../../mobile/README.md)，Web 本地 Vite 代理见 [frontend-web/README](../../../frontend-web/README.md#local-development)。设备验收与模拟浏览器回归按[验证篇](../08-engineering/verification.zh-CN.md)区分，不能用 Web 通过推断扫码、键盘或系统分享已通过。

源码：[Web runtime client](../../../frontend-web/src/runtimeClient.js)、[平台注入](../../../frontend-web/src/platform.jsx)、[ticket](../../../frontend-web/src/ticket.js)、[Mobile native bridge](../../../mobile/src/native.js)、[Mobile app](../../../mobile/src/MobileApp.jsx)、[Compose](../../../docker-compose.yml)。验证：[Web 客户端](../../../frontend-web/src/runtimeClient.test.js)、[Mobile ticket](../../../mobile/src/native.test.js)、[Mobile pairing](../../../mobile/src/MobileApp.test.jsx)。

[返回系列地图](../README.zh-CN.md)
