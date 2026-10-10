# 分层与装配：依赖只朝一个方向

English | [简体中文](layers-and-composition.md)

执行内核描述“怎样完成一轮”，具体的模型 SDK、JSONL 文件和工具实现由装配根注入。内核不需要知道它正在服务 CLI 还是 Web。

~~~mermaid
flowchart TB
    S["runtime/server<br/>协议与协调"] --> B["bootstrap/container.py<br/>唯一生产装配根"]
    B --> C["runtime/core<br/>回合与流"]
    B --> I["infrastructure<br/>模型 / 存储 / 工具"]
    C --> A["application<br/>上下文 / 工具编排 / ports"]
    A --> D["domain<br/>事件 / 错误 / 取消"]
    C --> D
    I -. "实现 ports" .-> A
~~~

[AgentContainer](../../../agent/bootstrap/container.py) 显式接收会话 store、模型客户端、ShellTools、WebSessions 和共享资源，再组装 ContextManager、ToolCallProcessor、TurnRunner、AgentRuntime。runtime/core 不反向导入 runtime/server、bootstrap 或具体 infrastructure；Surface 也不持有 Python 业务对象。

这让生命周期可被看清：Worker 级资源由 RuntimeWorker 创建，单次活跃执行在 ExecutionCoordinator 中装配，application 依赖抽象端口，infrastructure 在边界外实现它们。新增 Provider 或工具时，通常改变适配与装配，而不是改写回合循环。

## 看代码时先找谁负责装配

一个工具需要会话 ID、取消信号和输出存储，不代表它应该自行寻找全局 Worker。ToolSpec 声明调用契约，容器注入依赖，执行器补入私有运行时参数，具体 handler 再执行动作。依赖来源可沿构造函数追溯，测试也能用本地实现替换模型与文件边界。

Server 还承担执行互斥、跨回合续接和连接订阅，不能把它缩写为“只转发请求”。Core 管一轮内部的采样与工具循环；application 提供可复用服务。依赖图表示模块方向，不是进程隔离图，生产运行中这些 Python 模块在同一进程里。

代码入口：[装配根](../../../agent/bootstrap/container.py)、[应用端口](../../../agent/application/ports/)、[领域事件](../../../agent/domain/events.py)。验证：[依赖方向测试](../../../test/test_agent_architecture.py)、[容器测试](../../../test/test_agent_container.py)。

[返回系列地图](../README.zh-CN.md)
