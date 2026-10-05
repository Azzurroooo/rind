# Plan：保存步骤状态，压缩时保住进度

计划是当前会话的控制状态。update_plan 每次提交完整列表，避免增删单个步骤时产生难以追踪的局部变更。

~~~mermaid
flowchart LR
    M["update_plan：完整有序列表"] --> V["normalize_plan"]
    V --> F[("会话 plan.json")]
    F --> S["build_plan_snapshot"]
    S --> H["压缩 handoff 附加计划快照"]
    M --> E["plan_updated / tool_result"]
    E --> UI["Surface 计划视图"]
~~~

每项包含 step 和 status；状态是 pending、in_progress、completed、cancelled，最多一个 in_progress。数组顺序就是显示与执行优先级；空列表清空计划。文件写入使用同目录临时文件和替换，要求会话已经持久化。

压缩时，CompactionService 读取当前 plan.json 的有界摘要并附到 handoff，因此模型不只依赖对话中很早以前的 update_plan 调用。计划描述“还要做什么”，不应承载事实研究笔记。

plan_updated 事件在 TurnRunner 解析模型调用时就会发出；它不能单独证明 plan.json 写入成功，最终要看 tool_result。这个区别也适用于 UI：声明准备更新和已提交更新是不同阶段。

## 同一个计划只有一份当前值

~~~json
{"plan":[{"step":"定位失败","status":"completed"},{"step":"修复并运行回归","status":"in_progress"}]}
~~~

这是 update_plan 的参数形状，不是 plan.json 的完整磁盘格式；磁盘文件还带 schema_version。下一次提交必须给出完整的新列表，旧步骤若不在列表中就不属于当前计划。写入时的 schema 与状态校验防止 UI 和模型各自猜测一套计划结构。

计划文件损坏时不能把它默认为“任务都完成了”。读取错误需要明确报告，压缩附加计划采用尽力读取；即使计划缺席，原始工具与消息事实仍可用于追溯，但新 handoff 不应虚构进度。

代码入口：[计划工具](../../../agent/infrastructure/tools/planning.py)、[计划存储](../../../agent/infrastructure/persistence/plan.py)、[计划规范](../../../agent/domain/planning.py)。验证：[计划工具](../../../test/test_plan_tool.py)、[会话隔离](../../../test/test_plan_session_isolation.py)、[压缩摘要](../../../test/test_plan_context_summary.py)。

[返回系列地图](../README.md)
