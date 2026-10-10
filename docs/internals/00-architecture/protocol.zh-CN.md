# 统一协议：请求闭合，事件推进

English | [简体中文](protocol.md)

协议版本为 2。一次调用有 request_id 对应一次 response；持续变化通过独立的 session/update event 发送。这两个通道解决不同问题，不能互相替代。

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant D as RuntimeDispatcher
    participant R as Runtime
    S->>D: request(request_id, session/prompt)
    D->>R: 启动回合
    R-->>D: RuntimeEvent
    D-->>S: event(session/update, sequence, durability)
    R-->>D: 回合结束
    D-->>S: response(request_id, result)
~~~

initialize 公布 protocol_version、methods、capabilities、当前会话和命令目录。公共方法如 session/prompt、session/replay、model/set 使用稳定名称；产品扩展放在 rind/ 命名空间，并按能力发现调用。事件封装统一带 session_id、turn_id、sequence、durability；具体类型在 event.type。

durable 表示可从会话事实重建的关键进度，例如回合开始/结束和工具结果；incremental 用于流式文本等即时展示。持久历史光标与跨回合任务事件不是同一个计数。断连后客户端重放历史，再用任务和 live-turn 快照补齐当前状态。

## 最小请求与两个不同的确认

~~~json
{"kind":"request","request_id":"r-1","method":"session/prompt","params":{"session_id":"session-1","input":"解释当前改动"}}
~~~

request_id 是调用关联标识，session_id 选定持久会话，turn_id 标识执行回合，event_id 标识具体事件。它们不是可互换的“任务编号”。连接上的 sequence 服务于事件流顺序，也不能直接当作 after_cursor。

普通 prompt 的 response 在回合结束后返回；支持请求作用域的 one-shot 还会等待本次任务续接。另一方面，队列方法的 accepted 只确认接收，实际投递由 queued_input_delivered 通知。客户端应根据调用契约判断完成，而不能把任何 response 都显示成“工作已完成”。

代码入口：[Python 协议](../../../agent/runtime/server/protocol.py)、[Dispatcher](../../../agent/runtime/server/dispatcher.py)、[CLI 镜像](../../../frontend-cli/lib/runtime-protocol.js)。验证：[协议回归](../../../test/test_runtime_server_protocol.py)、[golden fixture](../../../test/fixtures/runtime_protocol.golden.jsonl)。

[返回系列地图](../README.zh-CN.md)
