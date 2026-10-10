# 受管任务：命令、等待和通知各有状态

English | [简体中文](managed-tasks.md)

一个命令可以仍在运行，而调用它的工具已经返回。Rind 用 task_id 跟踪同一进程，handoff 记录它是否已交给后台，notify 决定结束后怎样继续。

~~~mermaid
stateDiagram-v2
    [*] --> Starting: 先保存启动意图
    Starting --> Running: 启动成功
    Starting --> Failed: 启动失败
    Running --> Running: 等待超时或 release_wait，交回控制权
    Running --> Completed: 退出码为 0
    Running --> Failed: 非零退出或执行错误
    Running --> Cancelled: 显式取消
    Running --> TimedOut: 到达运行期限
    Running --> Lost: 失去可确认的进程所有权
~~~

| 控制 | 改变什么 | 不代表什么 |
| --- | --- | --- |
| yield_time_ms | 首次工具调用的等待窗口 | 进程运行期限 |
| timeout_ms | 命令允许运行的期限 | 模型请求超时 |
| task_control read / wait | 查看输出或有界等待 | 领取并移除输出 |
| rind/task/release_wait | 提前释放当前等待 | 终止进程 |
| task_control cancel | 终止拥有的进程树 | 删除历史任务记录 |

notify=on_exit 用于结束后还要处理结果的命令；notify=manual 适合服务或 watcher，需自行检查就绪，不能靠进程还活着证明服务可用。UI 的 background_wait 只统计当前 Worker 已提交并交给后台的 on_exit 任务，且受中断、Goal 和请求作用域约束；它不是“所有后台进程个数”。

默认 ProcessSupervisor 最多保留 8 个受管理的进程记录，结束后符合条件的记录会退休，持久事实仍在日志中。任务监视与模型回合分开，因此模型空闲时仍能收到输出和终态。

代码入口：[监督器](../../../agent/infrastructure/tools/shell/supervisor.py)、[任务状态](../../../agent/domain/tasks.py)、[background_wait](../../../agent/runtime/server/execution.py)。验证：[Shell 任务](../../../test/test_shell_tasks.py)、[后台等待](../../../test/test_bash_background_wait.py)。

[返回系列地图](../README.zh-CN.md)
