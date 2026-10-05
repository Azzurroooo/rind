# Inside Rind：读懂 Worker 内核

**[打开完整阅读地图：9 组、52 篇](internals/README.md)**

从系统结构、执行时序、数据投影、能力扩展和可靠性五个角度，解释 Rind 当前代码如何工作。每篇都有 Mermaid 图、机制说明和源码/测试入口。

| 主题 | 从这里进入 |
| --- | --- |
| 系统全景与边界 · 5 篇 | [系统地图](internals/00-architecture/system-map.md) |
| Worker 与执行内核 · 9 篇 | [Worker 生命周期](internals/01-runtime/worker-lifecycle.md) |
| 上下文与压缩 · 7 篇 | [提示来源](internals/02-context/prompt-assembly.md) |
| 持久化 · 5 篇 | [会话结构](internals/03-persistence/session-store.md) |
| 工具系统 · 8 篇 | [工具注册](internals/04-tools/tool-registry.md) |
| 长任务与协作 · 5 篇 | [后台任务](internals/05-autonomy/managed-tasks.md) |
| 模型 · 3 篇 | [供应商适配](internals/06-models/provider-adapters.md) |
| Surface · 6 篇 | [交互式 CLI](internals/07-surfaces/interactive-cli.md) |
| 横切工程 · 4 篇 | [信任边界](internals/08-engineering/trust-boundaries.md) |

想先抓住设计要点：读[资源所有权](internals/01-runtime/resource-ownership.md)、[压缩交接](internals/02-context/compaction-handoff.md)、[工具结果双视图](internals/04-tools/tool-results.md)、[任务通知与续接](internals/05-autonomy/task-notifications.md)、[one-shot 请求作用域](internals/07-surfaces/one-shot.md)。

需要启动项目：读[CLI 源码运行](internals/07-surfaces/interactive-cli.md#从源码运行)、[配置与凭证](internals/06-models/authentication-and-settings.md)、[Desktop](internals/07-surfaces/desktop.md)、[Web/Mobile](internals/07-surfaces/web-and-mobile.md)、[消息网关](internals/07-surfaces/gateway.md)。
