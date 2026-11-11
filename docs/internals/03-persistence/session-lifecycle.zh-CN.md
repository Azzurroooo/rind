# 会话从草稿到分叉

English | [简体中文](session-lifecycle.md)

会话 ID、落盘目录和活跃执行不是同一个时刻产生的。把三者拆开，启动、切换和预览才能保持轻量。

~~~mermaid
stateDiagram-v2
    [*] --> Draft: 默认启动保留 ID
    Draft --> Persisted: 首条用户任务或显式 Goal
    [*] --> Persisted: session/new 显式创建
    Persisted --> Active: prompt / compact
    Active --> Persisted: 回合终态，释放容器
    Persisted --> Forked: session/fork
    Persisted --> Deleted: session/delete
~~~

SessionService 的默认启动草稿在内存中有稳定 ID，不写目录；session/new 则立即持久化，便于跨进程路由。会话列表、switch 和 replay 不需要把它变成活跃执行。打开已有会话时验证 session_id、schema、工作区与 Team 身份绑定。

fork 在指定用户消息**之前**截取快照；复制保留的消息、相关工具记录、有效压缩记录与附件，生成新 ID 和 parent_session_id。受管进程和任务日志不随 fork 转移，旧进程也不由新会话接管。删除会话先阻止继续启动、停止其活跃执行和 owned Shell 任务，然后删除持久目录与索引。

## 分叉保留什么，必须逐类判断

分叉点之前的历史和相关附件属于新会话的起点；被选中的用户消息留给 Surface 重新编辑，因此不是“执行完那条消息后”再分叉。相关工具记录按引用复制，后台进程所有权则不能靠复制 JSON 转移。

fork 的 meta 由原元数据派生并改写身份等字段，不能笼统宣称 Goal、turn_state 等所有状态都会清空。若调用方需要新的业务状态，应检查具体返回与元数据，而不是仅由新 session_id 推断它是完全空白的执行环境。

代码入口：[SessionService](../../../runtime/src/server/session-service.ts)、[fork 实现](../../../runtime/src/infrastructure/persistence/session-store.ts)、[Worker 删除](../../../runtime/src/server/worker.ts)。验证：[启动会话](../../../runtime/test/server-protocol.test.js)、[分叉](../../../runtime/test/server-protocol.test.js)、[删除](../../../runtime/test/server-protocol.test.js)。

[返回系列地图](../README.zh-CN.md)
