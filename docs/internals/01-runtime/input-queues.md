# 插话与后续输入是两条队列

steering 要影响正在进行的回合；follow-up 要等前一个任务走到安全边界。两者都先被接受，再由执行循环实际投递。

~~~mermaid
sequenceDiagram
    participant S as Surface
    participant R as AgentRuntime
    participant T as TurnRunner
    S->>R: steer(text) 或 follow_up(text)
    R-->>S: accepted + input_id + pending
    alt steering
        T->>R: 下一采样前取一条
        R-->>T: FIFO steering
    else follow-up
        R->>R: 前一轮采样结束后取一条
    end
    R-->>S: queued_input_delivered(input_id)
~~~

每条队列最多 4 项、合计文本上限各 8,000 字符。正常消费按 FIFO；未指定 input_id 的撤回操作取最新一条，指定 ID 则取对应的尚未投递项。accepted 只说明进入队列，queued_input_delivered 才说明已写入回合；Surface 不能提前把它当作已发送的用户消息。

压缩、工具调用和取消也遵守这条边界：当前摘要请求不会被新插话改写；工具调用/结果必须闭合后再插入输入；取消会清空仍待处理的队列。

## 撤回和提升改变的是待投递项

两条输入 A、B 依次排入同一队列：正常投递先 A 后 B；不带 input_id 的撤回先取回最新的 B，让输入框恢复用户刚写的内容。指定 ID 则定位那一项。已经收到 delivered 的输入成为持久消息，不再属于可撤回队列。

follow-up 可以提升为 steering，把“完成后再做”改成“下一次采样前看到”。提升并不取消正在运行的模型 HTTP 请求；它改变下一次安全投递的时机。Surface 应保留 input_id 对齐接受、撤回和投递，避免同一文本在队列栏和已发送历史中重复出现。

代码入口：[输入队列](../../../agent/runtime/core/runtime.py)、[执行入口](../../../agent/runtime/server/execution.py)。验证：[队列回归](../../../test/test_runtime_input_queues.py)、[压缩输入流程](../../../test/test_compact_input_lifecycle.py)。

[返回系列地图](../README.md)
