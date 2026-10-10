# 压缩交接：替换模型视图，不销毁原始历史

English | [简体中文](compaction-handoff.md)

压缩的关键不是“写一段摘要”，而是形成一个能继续工具循环的边界：旧历史变成 handoff，最近一段对话原样留在后面。

~~~mermaid
flowchart LR
    RAW["原始消息<br/>旧历史 + 最近消息"] --> CUT{"按会话单元切分"}
    CUT --> OLD["待概括历史"]
    CUT --> RECENT["最近消息原样保留"]
    OLD --> SUMMARY["模型摘要 / 确定性回退"]
    SUMMARY --> PAIR["user 续接消息 + assistant handoff"]
    PAIR --> VIEW["新的模型视图"]
    RECENT --> VIEW
    RAW --> DISK[("原始 JSONL 保留")]
~~~

切分单位不能拆开 assistant tool_calls 与对应 tool 结果。摘要请求把 history 和 retained_recent_messages 分开，保留后者供参考却不在 handoff 中重复。预算预检只会缩短超长工具正文，不删用户文本或工具参数；仍放不下就拒绝提交。取消也在模型返回后、提交前再次检查。

成功 handoff 和确定性回退都记录策略。空摘要或非成功结束原因不能当作完整交接；Provider 用量即使摘要被丢弃也会记录。落盘时写 compactions.jsonl 和 compact_boundary，下一次投影用“用户续接消息 + 助手 handoff + 最近消息”替换旧上下文，并校验消息边界；原始历史仍可用于重放。

## 摘要自己也必须放进窗口

摘要请求预留 min(8,192, 窗口/10) 的输出预算，再留窗口 5% 的余量。超长工具正文可缩成头 2,000 字符和尾 2,000 字符，中间标出省略量；用户约束与工具参数不走这种缩短。预检仍放不下就失败，不能先截掉用户要求再宣称压缩成功。

| 压缩产物 | 作用 |
| --- | --- |
| 续接 user + assistant handoff | 建立可继续对话的消息边界 |
| 最近完整会话单元 | 保留工具调用和结果的近处细节 |
| Plan 快照、活跃/未消费任务引用 | 从当前控制状态补回待办与后台工作 |
| 图片快照路径 | 告诉后续模型从哪里重新读取证据 |

摘要模型的 reasoning 不作为新的业务推理历史保留；投影为 handoff 使用固定的非空 reasoning 标记满足相应兼容要求。压缩记录与边界消息分开落盘，只有匹配的有效对才被采用；这不是跨文件 ACID 事务，详见[会话存储](../03-persistence/session-store.zh-CN.md)。

代码入口：[压缩服务](../../../agent/application/context/compaction.py)、[handoff 构造](../../../agent/application/context/handoff.py)、[投影](../../../agent/infrastructure/persistence/message_projector.py)。验证：[压缩服务](../../../test/test_compaction_service.py)、[边界恢复](../../../test/test_compact_pipeline.py)。

[返回系列地图](../README.zh-CN.md)
