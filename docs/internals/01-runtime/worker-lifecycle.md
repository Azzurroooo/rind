# Worker 的一生

Worker 是常驻的协议服务，不是一个永远占着模型客户端的会话对象。初始化可以读会话和模型信息；真正执行时才装配 AgentContainer。

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant W as RuntimeWorker
    participant SS as SessionService
    participant EC as ExecutionCoordinator
    S->>W: initialize
    W->>SS: 解析现有会话或保留启动草稿
    W-->>S: session_id / methods / capabilities
    S->>W: session/prompt
    W->>EC: start(session_id)
    EC->>EC: 装配活跃容器
    EC-->>W: 回合结束后释放容器
    S->>W: shutdown
    W->>W: 停止接单并关闭拥有的资源
~~~

[RuntimeWorker](../../../agent/runtime/server/worker.py) 创建 SessionService、ExecutionCoordinator、共享的解析/归一化/压缩服务、ShellTools 和 WebSessions。首次 initialize 才启动一次过期模型目录刷新；关闭时取消并等待刷新任务，还要关闭活跃执行和 Shell 进程，最后关闭 Web 会话。

启动时保留稳定的 session_id，但默认草稿无需立即生成会话目录；第一条用户任务或显式 Goal 才使它落盘。浏览会话列表、模型、状态和重放不需要创建活跃 AgentContainer。这样“打开应用”不等于“启动一个 Agent 回合”。

## 初始化可以重复，副作用不能重复启动

initialize 使用锁保护首次初始化：清理工具输出、决定初始会话、设置 initialized 标记，再启动后台目录刷新。后续 initialize 读取当前 info 与 live_turn，不重复创建刷新任务或执行容器。这里的轻量是“不启动模型回合”，不是“完全没有文件 I/O”。

关闭先让 supervisor 停止接收新任务，再取消刷新、关闭执行与受管资源。这样资源拥有者仍在时就能进行清理，不让正在退出的 Worker 继续接收一条新的进程启动请求。正常退出可保存可解释的终态；强制杀进程只能依赖后续恢复识别不确定状态。

代码入口：[Worker](../../../agent/runtime/server/worker.py)、[会话服务](../../../agent/runtime/server/session_service.py)。验证：[Worker 生命周期](../../../test/test_runtime_worker.py)、[启动草稿](../../../test/test_startup_session.py)。

[返回系列地图](../README.md)
