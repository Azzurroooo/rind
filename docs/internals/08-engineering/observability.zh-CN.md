# 看见内核：先找事实层，再看传输层

English | [简体中文](observability.md)

界面少了一段内容，可能是模型没生成、Worker 没提交、事件没送达，也可能只是 Surface 没画出来。Rind 的观测入口覆盖这些不同阶段，不能只看终端最后一屏。

~~~mermaid
flowchart LR
    C["上下文组装"] --> I["context inspect<br/>来源与 token 估算"]
    C --> M["模型调用"]
    M --> P["消息 / 工具结果 / 用量落盘"]
    P --> E["运行时事件"]
    E --> S["Surface 状态与渲染"]
    P --> R["历史投影 / replay"]
~~~

| 想回答的问题 | 优先查看 | 读数边界 |
| --- | --- | --- |
| 模型究竟看到了哪些输入？ | context inspect、上下文来源标签 | 本地估算不等于供应商实测输入 token |
| 工具有没有真正提交结果？ | tool_calls.jsonl、消息投影、task journal | UI 的开始/增量事件不能代替结果事实 |
| 为什么断线后缺少文字？ | 会话历史、订阅 after_cursor、当前回合快照 | 连接 sequence 与历史 cursor 不是同一个序号 |
| token 花在回答还是压缩？ | usage.jsonl 的调用分类 | 用量账本不计算货币价格 |

## 一条实用排查顺序

先用 session_id、turn_id、tool_call_id 或 task_id 定位持久记录，再看订阅事件、`context inspect` 与 Surface。启动与协议诊断走 stderr；stdio 的 stdout 必须仍是合法协议流，混入一行日志就会破坏消费者。

源码：[context inspect 分派](../../../runtime/src/server/dispatcher.ts)、[启动诊断](../../../runtime/src/server/transports.ts)。验证：[上下文检查](../../../runtime/test/server-protocol.test.js)、[回合执行](../../../runtime/test/context-and-turn.test.js)。关联：[事件](../01-runtime/event-system.zh-CN.md)、[用量账本](../03-persistence/usage-ledger.zh-CN.md)。

[返回系列地图](../README.zh-CN.md)
