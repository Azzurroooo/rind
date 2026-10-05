# 任务日志：后台进程的事实账本

受管 Shell 进程可能比模型回合活得更久，所以它的状态不能只放在 AgentContainer 内。TaskJournal 以每会话 tasks.jsonl 保存进程事实和来源身份。

~~~mermaid
flowchart LR
    START["bash 启动"] --> J[("tasks.jsonl")]
    J --> RUN["运行 / 输出更新"]
    RUN --> J
    J --> TERM["completed / failed / cancelled / timed_out / lost"]
    TERM --> J
    RESTART["新 Worker"] --> LEASE{"旧 Worker lease 还活着？"}
    LEASE -->|"否，状态不明"| LOST["记为 lost；不重跑命令"]
    LOST --> J
~~~

Worker lease 防止另一个活着的 Worker 领养或发信号给不属于自己的进程。创建时按 session_id 和 origin_tool_call_id 去重；重启时无法确认进程所有权，就追加 lost 状态，而不是偷偷再次执行命令。终态与稳定 event_id 一起提交，供通知系统恢复投递。

任务缓存是有界的，日志仍是权威来源。维护阶段可清理已消费的旧输出，并保留任务事实与去重身份；因此“追加事实”不等于输出文件永不整理。损坏的中间日志会拒绝执行，只有末尾不完整记录可以按边界修复。

## 为什么任务身份要长期留下

启动意图先写日志，再创建进程：如果这两步之间或进程启动后 Worker 崩溃，新 Worker 可看到这次 origin_tool_call_id 曾经进入启动流程。它无法据此证明进程是否真的运行过，所以用 lost 表达不确定性，保留去重身份，避免重试时重复产生副作用。

终态、通知投递和通知消费也不是同一步。日志保存足够的信息，让恢复者区分“进程结束了”“消息进入会话了”“模型看过了”。旧输出可以在满足维护条件后删除，任务身份和结果状态却仍用于解释历史。

代码入口：[TaskJournal](../../../agent/infrastructure/persistence/task_journal.py)、[ProcessSupervisor](../../../agent/infrastructure/tools/shell/supervisor.py)。验证：[任务日志](../../../test/test_task_journal.py)、[日志索引](../../../test/test_task_journal_index.py)。

[返回系列地图](../README.md)
