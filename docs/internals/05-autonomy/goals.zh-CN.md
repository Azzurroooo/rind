# Goal：跨回合保留“还没完成”

English | [简体中文](goals.md)

Goal 是会话 meta 中的 objective 与 status。回合结束只说明这一轮执行停下，不等于用户目标已实现；active Goal 可以安排新的检查点继续。

~~~mermaid
stateDiagram-v2
    [*] --> Active: 用户设置目标
    Active --> Active: 回合结束，检查点续接
    Active --> Paused: 用户暂停或回合取消
    Active --> Blocked: 模型标记受阻或回合失败
    Active --> Complete: update_goal complete
    Paused --> Active: 用户恢复
    Blocked --> Active: 用户恢复
    Complete --> [*]: 清除或结束
~~~

目标文本限制 4,000 字符。协议提供 get、set、status、clear；模型工具 update_goal 只能置 complete 或 blocked，不能自己创建目标。策略提示要求按目标逐项查证后再宣布完成，但内核不自动证明业务成果；它保证状态机和调度边界。

协调器优先处理待交付任务通知。若仍有 on_exit 后台任务等待完成，就不靠重复 Goal 检查点忙转；没有待处理通知、没有等待任务且 Goal 仍 active 时，写入内部 goal_checkpoint 并通过普通 run_turn 执行。失败和中断抑制继续，手动 compact 不应重启已经停止的目标。

当前公开 Goal 模型只有 active、paused、blocked、complete，没有 token_budget 字段或可设置的 budget_exhausted 状态。协调器中存在该名称的防御性判断，不能据此在文档宣称已实现 Goal 预算产品功能。

## Goal、Plan 和后台任务如何配合

Plan 保存当前步骤，Goal 保存整体目标，Task 保存真实进程状态。三者不相互代替：步骤全标 completed 不会自动证明 Goal 完成；Goal active 也不能让模型忽略仍在运行的测试；测试退出成功则只是一个事实，需要模型结合目标判断。

例如目标是“修复并验证”，模型启动测试后可以结束当前回合。若还有 on_exit 测试任务，协调器等待通知而不是不停发“继续”；测试终态送达后走普通回合，模型据结果修复或调用 update_goal。省下空转来自门控条件，而不是强迫模型永远保持一条长连接。

代码入口：[Goal 模型](../../../agent/domain/goal.py)、[Goal 工具](../../../agent/infrastructure/tools/goal.py)、[检查点提示](../../../agent/prompts.py)、[调度](../../../agent/runtime/server/execution.py)。验证：[运行时流程](../../../test/test_async_runtime.py)、[续接与 Goal](../../../test/test_task_continuation.py)。

[返回系列地图](../README.zh-CN.md)
