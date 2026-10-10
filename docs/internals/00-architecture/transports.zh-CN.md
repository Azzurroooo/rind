# 同一协议，不同连接寿命

English | [简体中文](transports.md)

传输层只负责把协议消息送达，不重新实现 Agent 行为。最重要的差异是**谁拥有 Worker 的寿命**。

~~~mermaid
flowchart TB
    CLI["CLI Node 进程"] -->|"stdio / JSONL"| WS["StdioRuntimeServer"]
    DESK["Electron main"] -->|"stdio / JSONL"| WS
    WEB["Web / Mobile"] -->|"WebSocket"| WW["WebRuntimeServer"]
    GATE["Gateway WorkerClient"] -->|"stdio 或 WebSocket"| X["协议连接"]
    WS --> D["RuntimeDispatcher"]
    WW --> D
    X --> D
    D --> W["RuntimeWorker"]
~~~

stdio 连接与其启动的 Worker 绑定：CLI 和 Gateway 的本地连接关闭 stdin、等待 stdout 排空与进程退出；正常 shutdown 要等待 Worker 自己停止拥有的任务。WebSocket 连接则可以断开和重连，浏览器关闭不会自动杀掉常驻 Worker。Desktop 通过 Electron main 隔离子进程，preload 限制 renderer 可调用的方法。

WebSocket 入口还要验证连接凭证；它不是“把 stdio 换成网络端口”这么简单。协议层的订阅、重放和快照让长连接中断后仍能恢复视图，而执行语义保持在 Worker 内。

## 连接断开以后，谁还活着

| 入口 | 传输与拥有者 | 断开后的判断 |
| --- | --- | --- |
| 本地 CLI / one-shot | Surface 启动 stdio 子进程 | Surface 负责发起正常关闭并等待退出 |
| Desktop 本地界面 | renderer → preload → main → stdio | main 拥有 Worker，不由单个 UI 组件持有 |
| 独立 Web | WebSocket → Python WebRuntimeServer | 单个 socket 关闭不等于服务退出 |
| Desktop 远程访问 | WebSocket → Electron Gateway → 本地 Worker | 远程入口撤销可以保留本地执行 |
| 消息 Gateway | 自有 WorkerClient 选择 stdio 或 WebSocket | 自己启动的进程与仅连接的服务有不同清理责任 |

图中的 WebRuntimeServer 是独立 Python Web 模式；Desktop 远程 Gateway 则是另一条桥接路线。它们共用协议语义，不能据此把认证、进程归属和退出流程画成完全相同的实现。

代码入口：[stdio](../../../agent/runtime/server/stdio.py)、[WebSocket](../../../agent/runtime/server/websocket.py)、[Desktop bridge](../../../desktop/src/preload/types.ts)。验证：[Web Runtime 测试](../../../test/test_web_runtime.py)、[stdio 关闭测试](../../../test/test_gateway_stdio_shutdown.py)。

[返回系列地图](../README.zh-CN.md)
