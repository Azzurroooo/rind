# 上下文预算：估算与实测互相校准

English | [简体中文](context-budget.md)

模型窗口是上限，发送前的本地估算是预警，Provider 返回的实际用量则能校准下一轮判断。Rind 不把字符数伪装成精确 token。

~~~mermaid
flowchart LR
    MSG["当前消息"] --> EST["本地估算<br/>tiktoken 或启发式"]
    USAGE["上次 assistant 实测 input tokens"] --> ANCHOR["同模型 / 同压缩代校验"]
    EST --> ANCHOR
    ANCHOR --> ACTIVE["活动 token 估计"]
    ACTIVE --> LIMIT{"达到自动压缩线？"}
    LIMIT -->|"是"| COMPACT["触发压缩"]
    LIMIT -->|"否"| SAMPLE["继续采样"]
~~~

ContextBudget 保存窗口、硬上限以及 system/conversation/tool 的诊断预算；默认自动压缩线为窗口的 90%。ContextEstimator 优先用 tokenizer，失败则按英文与 CJK 的启发式估算，并单独计入图片。分区预算用于报告压力，不等于逐类硬截断。

可用的实测锚点必须来自 assistant 采样，且压缩代次、模型与本地估算满足校验；否则回退到本地估算。锚点有效时，从上次服务端 input tokens 加上本地新增量，比例被限制在 0.2–2.0。context inspect 展示这些来源和决策，让自动压缩的原因可解释。

## 校准公式的具体含义

可用锚点下，活动估计约为：上次服务端输入 token + 本地新增 token × clamp(上次服务端输入 / 上次本地估计, 0.2, 2.0)。例如上轮服务端 10,000、本地 8,000，本轮本地增加 800，则活动估计是 11,000；换模型、压缩或本地估计反而变小时，不能沿用这个增长锚点。

没有可靠模型窗口时，默认窗口为 256,000 token；已知模型能力会覆盖它。本地优先使用 cl100k_base，缺少 tokenizer 时使用 CJK/其他文本启发式。因此 90% 触发线提供余量，却不保证供应商永远不会拒绝请求，仍需要 context-length 错误恢复路径。

代码入口：[估算器](../../../agent/application/context/estimator.py)、[锚点逻辑](../../../agent/application/context/manager.py)、[用量正规化](../../../agent/application/context/token_usage.py)。验证：[估算回归](../../../test/test_context_estimator.py)、[预算回归](../../../test/test_compact_budget.py)。

[返回系列地图](../README.zh-CN.md)
