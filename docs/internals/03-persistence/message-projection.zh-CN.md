# 消息投影：磁盘原文不等于模型所见

English | [简体中文](message-projection.md)

磁盘保存原始消息与工具记录；模型请求和 UI 重放各需要不同的视图。投影函数负责选择、补齐和校验，不通过改写旧文件“修历史”。

~~~mermaid
flowchart LR
    RAW[("messages.jsonl")] --> P["project_messages"]
    TOOLS[("tool_calls.jsonl")] --> P
    COMPACT[("compactions.jsonl")] --> P
    P --> MODEL["模型视图<br/>最近 handoff + 保留后缀"]
    P --> UI["重放视图<br/>消息 ID + 时间戳"]
~~~

assistant 的 tool_calls 元数据与工具记录按 call ID 对齐；如果结果缺失，投影会给明确的“结果不可用，调用可能已执行”占位，不假称结果成功。工具的 model_content 按已保存内容进入后续上下文；终端预览的变化不会悄悄重写历史。Skill 快照和任务通知可供模型使用，UI 默认会过滤内部通知。

最近一次有效 compact_boundary 才改变模型视图：旧内容由续接 user 消息和 assistant handoff 替换，原样保留的后缀照常追加。UI 要历史 ID 与时间戳时显式开启 include_ids；模型默认不携带这些展示字段。应用压缩后若消息边界校验失败，会拒绝投影，而不是继续发送破碎工具消息。

## 缺失结果不能被“补成成功”

若磁盘有 assistant 的调用 c1，却没有 c1 的结果，投影会构造 result unavailable 说明：调用可能执行过，也可能未执行。这样模型看到完整的调用—结果形状，同时仍知道结果不确定。它不会从 UI 的进度文本推导出成功，更不应据此无条件重复有副作用的操作。

有效 compact pair 的查找与投影后边界校验是两步：没有匹配的有效压缩对时不应用那次压缩；应用后如果工具/交接结构不合法才拒绝该投影。include_internal、include_ids、compacted 等选项决定读者需要的视图，不改变磁盘原文。

代码入口：[消息投影](../../../agent/infrastructure/persistence/message_projector.py)、[边界校验](../../../agent/domain/message_boundary.py)。验证：[压缩投影](../../../test/test_compact_pipeline.py)、[重放时间](../../../test/test_replay_message_time.py)。

[返回系列地图](../README.zh-CN.md)
