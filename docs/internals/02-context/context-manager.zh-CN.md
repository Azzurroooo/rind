# ContextManager：把会话事实变成模型请求

English | [简体中文](context-manager.md)

ContextManager 的输入不是 UI 屏幕文字，而是 SessionStore 对历史的投影。它叠加动态指令、计算预算，再输出不含内部标记的模型消息。

~~~mermaid
flowchart LR
    STORE[("持久会话")] --> PROJECT["消息投影"]
    PROJECT --> MERGE["合并 pending 与系统注入"]
    DOC["RIND.md / Skill 目录 / 临时系统消息"] --> MERGE
    MERGE --> EST["ContextEstimator"]
    EST --> STATS["stats + decisions"]
    EST --> STRIP["去掉内部 _context_kind"]
    STRIP --> MODEL["模型消息"]
~~~

build_messages_async 先取包括内部消息的会话切片，再加 pending overlay；RIND.md、临时系统消息、Skill 目录插在第一条 system 之后。带 _context_kind 的副本用于上下文分区快照，真正发给模型前剥掉内部字段。结果同时给出消息、统计和决策，例如系统/会话/工具估算量与是否触发自动压缩。

正常路径不会凭旧消息太长就悄悄丢弃用户要求。只有上下文超长恢复明确启用 allow_rescue 时，才以占位文本替换最早的冷消息，并保留末尾热消息；这不是常规压缩，也不改写磁盘历史。

## 一份内容，两份输出

ContextBuildResult 同时携带 messages、internal_messages、stats 和 decisions：messages 发给模型，internal_messages 保留来源标签供检查，stats 给出预算读数，decisions 说明注入与恢复选择。检查面板与真实请求出自同一次组装，减少“面板估算了一套，实际又发另一套”的偏差。

例如工作区规则改了，但旧对话没变：下次组装重新加载 RIND.md 注入，不需要把新规则冒充为旧历史消息。反过来，已经激活的 Skill 正文有会话快照，不能因为原 SKILL.md 后来变化就悄悄替换过去那次调用的内容。

历史读取失败会变成 PersistenceError；不能把读取异常当作“这是一个空会话”继续执行。这是投影入口的关键失败边界。

代码入口：[ContextManager](../../../agent/application/context/manager.py)、[会话投影](../../../agent/infrastructure/persistence/message_projector.py)、[上下文快照](../../../agent/application/context/snapshot.py)。验证：[ContextManager 测试](../../../test/test_context_manager.py)、[上下文快照](../../../test/test_context_snapshot.py)。

[返回系列地图](../README.zh-CN.md)
