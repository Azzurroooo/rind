# 看见内核：先找事实层，再看传输层

界面少了一段内容，可能是模型没生成、Worker 没提交、事件没送达，也可能只是 Surface 没画出来。Rind 的观测入口覆盖这些不同阶段，不能只看终端最后一屏。

~~~mermaid
flowchart LR
    C["上下文组装"] --> I["context inspect<br/>来源与 token 估算"]
    C --> M["模型调用"]
    M --> L["Chat 原始 trace（显式开启）"]
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
| SDK 返回了什么？ | 启用后的原始 LLM trace | 当前只有 OpenAI Chat 适配器调用 make_trace |

## Trace 的精度来自它靠近供应商

`RIND_TRACE_LLM=1` 或启动 `--trace-llm` 后，每个被接入的调用在 RIND_HOME/sessions/session_id/_llm_trace 下写一份 JSONL：request、原始 response chunk、end。记录逐行 flush，因此中途失败也可能留下定位材料；未取得 session_id 时不创建 trace。

trace 在模型流进入内核解析前记录，适合区分“供应商没发 tool call”和“解析/呈现漏了”。它会省略图片 bytes、base64 和 data URL 内容，但普通提示词和响应仍保留。不要将这项特性写成所有适配器都有的全链路追踪。

## 一条实用排查顺序

先用 session_id、turn_id、tool_call_id 或 task_id 定位持久记录，再看订阅事件与 Surface。只有问题确实在模型边界时才启用 trace 复现。启动与协议诊断走 stderr；stdio 的 stdout 必须仍是合法协议流，混入一行日志就会破坏消费者。

源码：[context inspect 分派](../../../agent/runtime/server/dispatcher.py)、[trace](../../../agent/infrastructure/llm/trace.py)、[Chat 接入点](../../../agent/infrastructure/llm/openai_chat.py)、[启动诊断](../../../agent/runtime/server/app_server.py)。验证：[上下文检查](../../../test/test_runtime_server_context.py)、[trace](../../../test/test_llm_trace.py)。关联：[事件](../01-runtime/event-system.md)、[用量账本](../03-persistence/usage-ledger.md)。

[返回系列地图](../README.md)
