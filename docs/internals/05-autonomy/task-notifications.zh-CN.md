# 自动续接：完成、投递、消费是三件事

English | [简体中文](task-notifications.md)

后台命令结束，不应立刻把一段输出塞进尚未闭合的工具对话。Rind 先保存进程终态，再确认初始工具结果已提交，最后在安全边界投递通知。

~~~mermaid
sequenceDiagram
    participant P as ProcessSupervisor
    participant J as TaskJournal
    participant T as ToolCallProcessor
    participant N as TaskNotifications
    participant R as TurnRunner
    par 进程独立推进
        P->>J: 终态 + 稳定 event_id
    and 工具提交独立推进
        T->>J: 初始工具结果已提交：committed
    end
    N->>N: 工具调用配对闭合？
    N->>R: 持久化 task_notification
    N->>J: delivered
    R->>R: 模型成功处理含任务引用的上下文
    R->>J: consumed
~~~

通知资格要求有 event_id、committed、handoff、notify=on_exit，且尚未 delivered、状态不是 cancelled。通知作为 user-role 内部消息落盘，meta.kind=task_notification；进程事实与 untrusted_process_output 分开，输出不会成为系统指令。稳定 ID 让恢复时能发现已写入消息但尚未确认的通知。

delivered 只证明通知已进入会话；consumed 在模型步骤成功后标记。如果模型失败，未消费引用和 continuation_error 仍保留。压缩也把活跃或未消费任务引用加入 handoff，避免长任务被摘要抹掉。

空闲会话由 ExecutionCoordinator 唤醒，同一会话仍只能运行一轮；中断会抑制续接，暂停/受阻的 Goal 也会挡住它。模型重试耗尽后停止自动推进，等待新用户输入。已通过终态工具结果交付的任务不再重复发送完成通知。

## 两个竞争场景

**进程先结束，工具结果后提交。** 终态可以先记入日志，但没有 committed 资格就不注入通知；否则模型上下文会在调用/结果中间插入一条新用户消息。

**通知已写入，模型采样失败。** delivered 已成立，consumed 尚未成立；系统保留引用和错误，避免把“送到上下文”当作“成功处理”。再次恢复时凭稳定 event_id 识别原通知，压缩也保留尚未消费的任务引用。

这套顺序降低重复和丢失风险，但不承诺业务动作全局恰好一次。外部进程的副作用是否发生，仍可能在崩溃边界变得不确定，任务日志用 lost 等状态诚实表达。

代码入口：[TaskNotifications](../../../agent/application/task_notifications.py)、[续接协调](../../../agent/runtime/server/execution.py)。验证：[通知投递](../../../test/test_task_delivery.py)、[自动续接](../../../test/test_task_continuation.py)。

[返回系列地图](../README.zh-CN.md)
