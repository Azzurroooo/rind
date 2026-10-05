# 压缩有三种入口，一条主流水线

用户手动压缩、达到自动阈值、Provider 拒绝过长上下文，触发条件不同；摘要生成和边界提交却复用同一个 CompactionService。

~~~mermaid
flowchart TD
    MAN["/compact 或 rind/session/compact"] --> PIPE["CompactionService"]
    AUTO["ContextManager 判断达到阈值"] --> PIPE
    ERR["Provider context-length error"] --> PIPE
    PIPE --> CORPUS["准备语料与保留后缀"]
    CORPUS --> SUM["生成 handoff"]
    SUM --> COMMIT[("提交压缩边界")]
    COMMIT --> REBUILD["重建上下文"]
~~~

手动压缩占用会话执行位置，发出 operation=compact 的 turn_started、context_compacted 和终态；若没有新输入，不额外启动对话采样。自动压缩发生在当前回合的采样前，原 turn_id 不变。首次 context-length 错误尝试压缩，后续恢复会收紧硬限制并启用显式的上下文 rescue。

压缩服务只负责生成并提交 handoff；**是否继续采样由调用者决定**。摘要前的输入预算预检若失败，会保留旧上下文并直接报错，不调用模型，也不将这类错误伪装成摘要失败后的确定性回退。

## 入口决定后续动作

| 入口 | 回合身份与后续动作 |
| --- | --- |
| 手动 compact | 独占执行位置，报告维护操作终态；不会无输入地额外聊天 |
| 自动阈值触发 | 在当前回合下一次采样前整理上下文，继续原任务 |
| context-length 错误 | 首次走压缩，后续收紧 hard limit 并尝试 rescue，受有界恢复约束 |

自动阈值看 ContextManager 的预算决策，不按“消息条数超过 N”触发。供应商仍可能比本地估算更早拒绝输入，所以错误恢复是必要补充；后续硬限制按 0.8 收紧，也不意味着无限重试直到碰巧成功。

代码入口：[TurnRunner](../../../agent/runtime/core/turn_runner.py)、[CompactionService](../../../agent/application/context/compaction.py)、[手动入口](../../../agent/runtime/core/runtime.py)。验证：[压缩主线](../../../test/test_compact_pipeline.py)、[输入与压缩](../../../test/test_compact_input_lifecycle.py)。

[返回系列地图](../README.md)
