# 取消与恢复：停止当前动作，保住已提交事实

English | [简体中文](cancellation-and-recovery.md)

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

沉默同样会结束模型读取：请求或流 600 秒没有送达任何内容即以 `timed_out` 失败，即使网关用 keep-alive 注释维持着连接。流中途卡住按 stream_interrupted 计，走同一套有界重试；之后回合以 turn_failed 结束，执行随之释放，会话可以继续接收输入。

用户中断会抑制自动续接，活跃 Goal 改为 paused；失败会令活跃 Goal blocked。Worker 正常关闭要尝试终止自己拥有的进程并等监视任务结束；强制杀死无响应 Worker 不能保证所有子进程都已清理。

代码入口：[取消 token](../../../agent/domain/cancellation.py)、[TurnRunner](../../../agent/runtime/core/turn_runner.py)、[执行协调](../../../agent/runtime/server/execution.py)。验证：[取消测试](../../../test/test_cancellation_token.py)、[任务恢复](../../../test/test_task_continuation.py)、[失败边界](../../../test/test_failure_boundaries.py)、[沉默的模型](../../../test/test_model_idle_journey.py)。

[返回系列地图](../README.zh-CN.md)
