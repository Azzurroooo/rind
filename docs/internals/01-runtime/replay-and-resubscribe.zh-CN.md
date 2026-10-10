# 重放：历史、活跃尾部和任务快照各司其职

English | [简体中文](replay-and-resubscribe.md)

断线重连不能只重播文本：已保存消息、尚在运行的回合，以及跨回合的后台任务，分别来自不同来源。

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant W as RuntimeWorker
    participant D as SessionStore
    participant E as ExecutionCoordinator
    participant T as ShellTools
    S->>W: session/replay(after_cursor)
    W->>D: 投影历史消息或 durable 事件
    W->>E: 当前 live_turn
    W->>T: 当前 tasks 快照
    W-->>S: 历史 + live_turn + tasks + background_wait
~~~

常规 replay 读取持久消息和 turn_state，并附上有界的 live_turn 覆盖层；它不启动 Agent。事件分页模式从消息、工具记录和终态重建 durable 事件。after_cursor 只计算对话的持久序号；任务更新不挤占这个光标。客户端应用任务快照时应替换旧状态，避免断连期间漏掉完成事件。

live_turn 只存在于仍活着的 Worker，供界面恢复尚未落盘的文字尾部、工具状态或待答问题；Worker 重启后只能依赖磁盘事实。切换会话或重放不应重新执行工具。

## 恢复的是视图，不是网络请求重试

断线前已显示一段 assistant_delta，断线后可能发生两种情况：助手消息已经完整提交，则从持久历史重建；采样仍进行，则还需要 live_turn 提供当前尾部。仅重放 durable 事件会缺少后者，仅保留旧客户端缓冲又可能漏掉断线期间的提交。

任务采用单独快照，是因为进程可以跨过多个 turn。after_cursor 不计任务快照，客户端也不应把一次快照应用误算成新的对话事件。Worker 重启后没有旧的实时尾部，恢复应诚实展示磁盘边界，而非把半条流式输出补成完整答案。

代码入口：[Worker.replay](../../../agent/runtime/server/worker.py)、[durable 投影](../../../agent/runtime/server/replay_events.py)、[Dispatcher replay](../../../agent/runtime/server/dispatcher.py)。验证：[协议重放](../../../test/test_runtime_server_protocol.py)、[会话恢复预览](../../../test/test_resume_preview.py)。

[返回系列地图](../README.zh-CN.md)
