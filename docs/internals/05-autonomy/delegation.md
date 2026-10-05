# 委派：独立执行，简短交接

delegate 对父 Agent 是一个等待结果的工具调用。子任务复用 Worker 的会话执行器，而不是启动另一套不受管理的代理循环。

~~~mermaid
sequenceDiagram
    participant M as 主 Agent
    participant D as TeamDelegator
    participant E as ExecutionCoordinator
    participant C as 专家执行
    M->>D: delegate(agent_id, task, mode)
    D->>D: 解析目标与校验模式
    D->>E: 注入的 session_runner
    E->>C: 独立会话与工作区
    C-->>E: 最终文本或错误
    E-->>D: content + session_id
    D-->>M: status + summary + published_paths
~~~

| 模式 | 执行与持久化 |
| --- | --- |
| execute | 创建 delegated_task 会话，记录 parent_session_id，在目标工作区执行并保留历史。 |
| inspect | 使用临时会话目录，只提供 read_file、glob、grep、skill；完成后清理临时会话。 |

两种模式都关闭用户问答，子专家不获得主 Agent 的再委派入口。多个纯 delegate 调用可以并发，甚至指向同一专家；它们各有会话，但共享目标工作区。取消沿父 token 传递，Worker 级文件修改队列被复用。

交接正文期望 JSON，包含 completed/blocked、summary、published_paths；summary 限长 4,000 字符。发布路径只接受确实存在且位于 shared 的目标。若子回复不是可解析 JSON，代码会把文本当简短结果处理，默认 completed；这不构成成果质量的自动验收，主 Agent 仍应核验发布文件。

代码入口：[TeamDelegator](../../../agent/infrastructure/team/delegation.py)、[子会话执行](../../../agent/runtime/server/execution.py)。验证：[委派生命周期](../../../test/test_team_delegation.py)、[并行批次](../../../test/test_parallel_delegate_calls.py)。

[返回系列地图](../README.md)
