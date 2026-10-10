# 每个会话只有一条执行通道

English | [简体中文](execution-coordinator.md)

用户回合、后台任务完成后的续接、Goal 检查点都可能要求模型运行。ExecutionCoordinator 把它们收束到同一个会话执行位置，避免两轮同时改写同一段历史。

~~~mermaid
flowchart TB
    U["用户输入"] --> Q["会话执行入口"]
    T["任务完成唤醒"] --> Q
    G["Goal 检查点"] --> Q
    Q --> L["等待该会话 turn_slot"]
    L --> CHECK{"拿到位置后重新检查资格"}
    CHECK -->|"失去资格 / 用户优先"| SKIP["让出本次自动续接"]
    CHECK -->|"可执行"| A["AgentContainer.run_turn"]
    A --> P[("提交消息与回合状态")]
    A --> R["空闲释放"]
~~~

协调器维护活跃容器、等待中的唤醒和请求作用域。拿到会话执行位置后还会重新检查资格：Goal 若暂停或受阻、任务通知尚未提交、会话已删除，就不能仅凭较早的唤醒启动回合。创建模型客户端和磁盘读取在全局协调锁之外，避免一个慢会话拖住所有会话。

同一会话一次只执行一轮，其他会话可以并行。续接不是凭空多开一个 Agent：它调用同一 run_turn 路径，因此得到相同的事件、持久化、取消与错误处理。

## 同一时刻来了三种请求

用户输入、任务完成通知、Goal 检查点可能同时到达。协调器先竞争会话 turn_slot；自动续接取得位置后仍需检查 queued_turn_starts、抑制标记、待通知任务和最新 Goal 状态。有其他排队的启动时，续接可直接让出，不能把较早收到的唤醒当成必须执行的命令。

手动 compact 也需要独占位置；已有活跃回合或排队启动时会拒绝压缩，而非并行改写上下文。显式用户业务输入可解除中断后的抑制；维护性 compact 保留抑制标记。这一细分避免用户只想整理上下文，却意外把已停下的长目标重新启动。

代码入口：[ExecutionCoordinator](../../../agent/runtime/server/execution.py)、[AgentRuntime](../../../agent/runtime/core/runtime.py)。验证：[自动续接](../../../test/test_task_continuation.py)、[运行时输入队列](../../../test/test_runtime_input_queues.py)。

[返回系列地图](../README.zh-CN.md)
