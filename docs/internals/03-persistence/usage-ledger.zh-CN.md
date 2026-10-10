# 用量账本：每个数字都有原始记录

English | [简体中文](usage-ledger.md)

Token 用量既帮助决定何时压缩，也用于用户查看消耗；这两种用途不应靠界面猜测流式文字长度。

~~~mermaid
flowchart LR
    MODEL["模型采样用量"] --> N["正规化 input / cached / output / reasoning"]
    COMPACT["摘要采样用量"] --> N
    N --> META[("会话最近用量")]
    N --> LEDGER[("~/.rind/usage.jsonl")]
    LEDGER --> SUM["按时间窗 / 模型 / 会话求和"]
    SUM --> UI["rind/usage/summary"]
~~~

TurnRunner 和 CompactionService 分别记录 assistant 与 compact 采样；已知 Provider 用量即使摘要被放弃，也应如实保留。会话 meta 存近期采样与上下文锚点，供下一次预算决策；用户级 usage.jsonl 以文件锁追加记录，跨会话汇总不依赖某个活跃容器。

summarize_usage 是纯归约：默认 7 天、最多 365 天，按日、模型和最近会话统计，不发明没有原始记录的费用数字。Provider 没返回用量时不能拿本地估算伪装成已计费量；缺失字段与汇总回退规则见下文。

## 汇总字段如何解释

每条账本记录带 sampling_kind、session_id、model、ts 及正规化用量。汇总按日分组，模型榜与最近会话各最多显示 5 项；total_tokens 为正时使用它，否则按 input_tokens + output_tokens 求量。cached 和 reasoning 单独报告，不再盲目加到总量上，避免把细分统计重复相加。

未返回任何用量时不会生成这次采样的精确账本记录；有用量对象但缺少某字段时，正规化可能将它记为 0。因而“没有记录”和“没有消耗”不是同一结论。账本写入还是尽力完成的诊断路径，写入失败应看日志，不能把汇总当成供应商账单的严格镜像。

代码入口：[用量账本](../../../agent/infrastructure/persistence/usage_ledger.py)、[汇总](../../../agent/application/usage_summary.py)、[用量正规化](../../../agent/application/context/token_usage.py)。验证：[账本回归](../../../test/test_usage_ledger.py)、[汇总回归](../../../test/test_usage_summary.py)。

[返回系列地图](../README.zh-CN.md)
