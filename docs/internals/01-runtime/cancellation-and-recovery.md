# 取消与恢复：停止当前动作，保住已提交事实

取消不是删除历史。它通过 token 打断模型或工具读取，保留已经落盘的消息与任务事实；恢复则从未闭合的边界继续，而不是盲目重做。

~~~mermaid
flowchart TD
    C["session/cancel"] --> T["CancellationToken"]
    T --> M["取消模型当前读取"]
    T --> X["通知工具等待"]
    M --> END["turn_cancelled 落盘"]
    X --> END
    R["恢复 running 回合"] --> P{"有未闭合工具调用？"}
    P -->|"有"| D["检查已提交结果并补完"]
    P -->|"无"| S["重新构造上下文"]
    D --> S
~~~

TurnRunner 对 stream_interrupted 有有界的步骤重试，并持久化重试次数；工具处理器按 call ID 复用已保存的结果，包括失败结果。恢复时若调用缺失结果，会记录“可能执行过也可能未执行”的明确占位，不能假装恰好一次。取消中的文件线程会等待已经开始的写入结束；后台进程需要独立的任务取消或 Worker 关闭处理。

用户中断会抑制自动续接，活跃 Goal 改为 paused；失败会令活跃 Goal blocked。Worker 正常关闭要尝试终止自己拥有的进程并等监视任务结束；强制杀死无响应 Worker 不能保证所有子进程都已清理。

代码入口：[取消 token](../../../agent/domain/cancellation.py)、[TurnRunner](../../../agent/runtime/core/turn_runner.py)、[执行协调](../../../agent/runtime/server/execution.py)。验证：[取消测试](../../../test/test_cancellation_token.py)、[任务恢复](../../../test/test_task_continuation.py)、[失败边界](../../../test/test_failure_boundaries.py)。

[返回系列地图](../README.md)
