# 一张图看懂 Rind

Rind 的核心不是某个界面，而是一条可复用的执行路径：Surface 把输入交给协议，Worker 协调会话与执行，内核调用模型和工具，结果落盘并以事件返回。

~~~mermaid
flowchart TB
    S["CLI / Desktop / Web / Mobile / Gateway"] --> P["协议连接"]
    P --> D["RuntimeDispatcher"]
    D --> W["RuntimeWorker"]
    W --> SS["SessionService<br/>读持久会话"]
    W --> EC["ExecutionCoordinator<br/>管活跃执行"]
    EC --> A["AgentContainer<br/>按需装配"]
    A --> R["AgentRuntime + TurnRunner"]
    R --> C["ContextManager"]
    R --> M["模型适配器"]
    R --> T["工具处理器"]
    C --> F[("JSONL 会话")]
    T --> F
    R --> E["RuntimeEvent"]
    E --> D --> P --> S
~~~

Server 和执行内核在**同一个 Python Worker 进程**里；两者之间没有第二层 RPC。CLI、Desktop 通过 stdio JSONL 连接，Web/Mobile 走 WebSocket，Gateway 通过自己的 WorkerClient 接入同一协议。Surface 负责输入、呈现和连接状态；Python 负责会话、上下文、模型、工具与任务。

这张图还有一条不该省略的反向边：会话事实写在磁盘，下一次执行重新读取。Worker 可以保留正在运行的任务和共享服务，却不为每个历史会话常驻一套 Agent。阅读后续文章时，始终区分**持久事实、当前执行、界面视图**三种状态。

## 同一个会话的三种形态

| 形态 | 放在哪里 | 存在多久 |
| --- | --- | --- |
| 持久事实 | messages、tool_calls、meta、tasks 等文件 | 跨回合、跨 Worker 重启 |
| 当前执行 | 容器、模型连接、队列、取消信号 | 执行活跃期间 |
| 界面视图 | Surface 的 transcript、输入框与任务面板 | 由客户端生命周期决定，可重建 |

例如浏览器刷新只丢掉第三层；Worker 仍可执行，重新订阅后从历史与快照恢复。Worker 重启会丢掉第二层，持久会话仍可打开，但旧进程不能凭一个 task_id 自动恢复为可控进程。沿这三层判断问题，比把“会话还在”理解为“所有状态都还在”更准确。

代码入口：[main.py](../../../main.py)、[RuntimeWorker](../../../agent/runtime/server/worker.py)、[装配根](../../../agent/bootstrap/container.py)。验证：[架构边界测试](../../../test/test_agent_architecture.py)。

[返回系列地图](../README.md)
