# 低负载来自清楚的资源所有权

English | [简体中文](resource-ownership.md)

“无状态”只适用于持久会话的来源：历史在磁盘，Worker 内存仍负责正在运行的进程、队列和取消。真正省资源的是**执行对象按需存在**。

~~~mermaid
flowchart TB
    subgraph W["Worker 寿命"]
        SS["SessionService"]
        SH["共享解析 / 归一化 / 压缩"]
        SHELL["ShellTools + ProcessSupervisor"]
    end
    subgraph A["活跃会话执行寿命"]
        AC["AgentContainer"]
        RT["AgentRuntime"]
        MC["模型客户端"]
        AC --> RT
        AC --> MC
    end
    SS --> DISK[("JSONL：持久事实")]
    SHELL --> JOURNAL[("任务日志")]
    W -->|"有任务才创建"| A
    A -->|"空闲释放"| W
~~~

ExecutionCoordinator 只保留活跃会话的容器；回合完成且没有排队工作时关闭模型客户端和容器。ShellTools 由 Worker 单独拥有：一个 bash 任务交给后台后，回合容器可以释放，进程与任务日志仍由同一个 Worker 管理。下一次续接按最新会话设置重新装配执行。

共享服务没有每会话长期可变状态；会话的消息、工具调用和目标重新从 SessionStore 读取。多个会话可以同时活跃，但每个会话的回合仍串行。这个所有权划分同时避免“每条会话一个常驻 Agent”和“释放容器时误杀后台任务”。

## 用一个长命令检验所有权

假设 bash 在等待窗口结束时仍运行：工具返回 task_id，模型暂时结束回合。ExecutionCoordinator 可以释放容器和模型连接，ProcessSupervisor 继续收集命令输出；命令结束后，通知系统再唤醒会话，创建新容器读取持久上下文。

| 动作 | 应释放 | 应保留 |
| --- | --- | --- |
| 回合空闲 | 该活跃容器与模型客户端 | 会话文件、Worker 拥有的受管进程 |
| 客户端断开 WebSocket | 该连接及订阅 | Worker 和仍在运行的执行 |
| Worker 关闭 | 活跃执行、共享连接、自己拥有的进程 | 持久会话和终态记录 |

因此“低负载”来自寿命分离，而非所有资源都无状态。共享服务也不意味着共享一个永不关闭的模型客户端；后者属于活跃容器。

代码入口：[Worker](../../../agent/runtime/server/worker.py)、[执行协调](../../../agent/runtime/server/execution.py)、[装配根](../../../agent/bootstrap/container.py)。验证：[空闲释放测试](../../../test/test_runtime_worker.py)、[Shell 生命周期](../../../test/test_worker_shell_lifecycle.py)。

[返回系列地图](../README.zh-CN.md)
