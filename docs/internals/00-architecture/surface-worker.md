# Surface 与 Worker：交互和执行分开

同一轮任务可以从终端、桌面、浏览器或手机发起，因为这些入口只负责把用户行为翻译成协议请求，并把事件翻译成可读界面。

~~~mermaid
flowchart TB
    subgraph Surface["Surface：交互进程"]
        I["编辑输入 / 菜单"] --> C["Runtime Client"]
        C --> V["事件驱动的界面状态"]
    end
    C -->|"request_id + method"| B["协议边界"]
    B -->|"response / session/update"| C
    subgraph Worker["Worker：Python 进程"]
        B --> S["Runtime Server"]
        S --> R["执行内核"]
        R --> F[("会话文件")]
    end
~~~

CLI 的 [runtime-client.js](../../../frontend-cli/lib/runtime-client.js) 启动或连接 Worker；输入缓冲、光标、TTY 渲染留在 Node。Desktop 的 Electron main 管 Worker 子进程，renderer 只能通过 preload 暴露的方法调用。Web 连接 WebSocket；Mobile 复用 Web Surface，以 Capacitor 提供配对和原生能力，手机上没有 Python 内核。

**边界的收益是职责清楚。** 换一种界面不用复制模型循环；修改工具语义也不必把业务判断散落到多个 Surface。协议响应表示请求结束，独立的事件表示执行中的变化；界面不能把两者当作两次回答。

## 交互状态与业务状态的分界

| 留在 Surface | 留在 Worker |
| --- | --- |
| 输入缓冲、光标、展开/折叠状态 | 已接受输入队列、消息提交、回合终态 |
| 菜单选择、任务卡片、通知呈现 | 工具执行、后台任务事实、Goal 调度 |
| 连接中、重连中、错误提示 | 会话存储、模型调用、压缩边界 |

这不是要求前端“没有状态”。前端必须有足够状态让输入与渲染稳定，但执行事实以 Worker 和持久记录为准。例如用户正在编辑的草稿不应因一条后台更新消失；反过来，客户端显示任务已完成，也不能替代 Worker 的任务终态。

代码入口：[CLI 客户端](../../../frontend-cli/lib/runtime-client.js)、[Desktop Worker 管理](../../../desktop/src/main/runtime.ts)、[Web 客户端](../../../frontend-web/src/runtimeClient.js)。验证：[CLI 协议测试](../../../frontend-cli/test/runtime-client.test.js)、[Web 协议测试](../../../frontend-web/src/runtimeClient.test.js)。

[返回系列地图](../README.md)
