# 模型流：有界缓冲，保持顺序

English | [简体中文](model-stream.md)

Provider SDK 的流不直接写 Surface。TurnRunner 先把它转成统一事件，流泵再用有界队列隔开模型读取速度和下游消费速度。

~~~mermaid
flowchart LR
    SDK["Provider async stream"] --> PARSER["MessageStreamParser"]
    PARSER --> PRODUCER["文本 / 工具参数 / 用量事件"]
    PRODUCER --> Q["有界队列<br/>256 事件 · 1 MiB"]
    Q --> BATCH["相邻文本合批<br/>25 ms 或 8 KiB"]
    BATCH --> R["RuntimeEvent"]
    R --> SURFACE["Surface"]
~~~

stream_pump.py 把文本和工具参数按字符边界拆开，队列同时约束条数和序列化字节数；过大的非文本事件会明确失败。相邻助手文本最多等待 25 ms 或累积 8 KiB，工具参数、用量和终止边界不乱序。消费者慢时生产者等待空间，不无限堆积事件。

取消会打断正在读取的模型流；生产结束和取消通过独立唤醒信号通知消费者，不依赖向已满队列塞结束标记。解析器收集完整文本、tool calls、reasoning 和 finish reason，只有用量被正规化后才写入用量记录。

## 合批只改变传送颗粒，不改变业务边界

假设模型连续给出文本 A、B，随后给出一个工具参数片段：A/B 可以合成一次 assistant_delta，工具事件却必须保持原位置，不能越过它继续拼接后面的文本。工具参数仍由解析器按 call ID 累积，只有完整调用才进入参数校验和执行。

这层队列约束的是待转发事件，不等于完整回答或 SDK 内部缓冲也只有 1 MiB。消费者停止、取消或解析失败时都必须关闭底层 stream 并结束读取任务，否则“有界队列”仍可能留下活着的网络资源。相关测试要同时检查顺序、背压和清理。

代码入口：[流泵](../../../agent/runtime/core/stream_pump.py)、[解析器](../../../agent/runtime/core/stream_parser.py)。验证：[流泵边界](../../../test/test_stream_pump.py)、[消息解析](../../../test/test_message_stream_parser.py)。

[返回系列地图](../README.zh-CN.md)
