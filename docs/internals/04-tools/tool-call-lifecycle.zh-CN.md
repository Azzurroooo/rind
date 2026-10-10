# 一次工具调用：先成为事实，再成为界面结果

English | [简体中文](tool-call-lifecycle.md)

工具执行完不等于调用已提交。ToolCallProcessor 必须归一化结果、写入会话，才能向下一次模型请求和通知系统交付它。

~~~mermaid
sequenceDiagram
    participant R as TurnRunner
    participant P as ToolCallProcessor
    participant X as ToolExecutor
    participant S as SessionStore
    R->>S: 保存 assistant 的 tool_calls
    R->>P: ParsedToolCall(call_id, name, raw_args)
    P->>S: 查找该 call_id 的已有记录
    alt 已有结果
        S-->>P: 复用结果
    else 新调用
        P->>X: 校验并执行
        X-->>P: 结构化执行结果
    end
    P->>S: 保存工具记录与 tool 消息
    P-->>R: tool_result 事件
    R->>R: 下一次采样
~~~

一批工具按顺序执行，异步 handler 直接 await，同步 handler 在线程里运行；结果按原调用顺序提交。

处理器发出开始、心跳、结果等事件。结果持久化失败会产生 PersistenceError 并阻止正常继续，避免 UI 显示成功而后续模型却没有结果。恢复时先检查已有 call ID，不重复执行已记录的结果；没有记录则不能仅凭 UI 曾显示过进度就假定操作成功。

## 结果提交也是跨回合的门闩

一个 bash 命令可能在初始调用尚未写入 tool 结果时就退出。如果进程观察者直接触发下一轮，历史中可能还只有 assistant tool_calls。处理器在持久化之后才通知任务系统 committed，续接还要检查工具配对闭合；这两道条件把进程速度与对话提交顺序解耦。

同样，“找到已有结果”表示复用已提交事实，不限于成功结果。恢复需要保留一次失败的信息，而不能把失败当作从未执行并自动重试副作用。并行委派也遵守原调用顺序提交，保证下一次模型请求看到稳定的配对关系。

代码入口：[processor](../../../agent/application/tools/processor.py)、[executor](../../../agent/application/tools/executor.py)、[工具记录](../../../agent/infrastructure/persistence/tool_call_repository.py)。验证：[工具处理器](../../../test/test_async_tool_call_processor.py)、[持久化失败](../../../test/test_tool_persistence_failure.py)。

[返回系列地图](../README.zh-CN.md)
