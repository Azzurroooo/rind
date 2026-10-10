# 有界系统：在数据放大的地方设置出口

English | [简体中文](limits-and-backpressure.md)

低常驻负载靠按需容器，高峰负载则靠局部上限。模型流、输入队列、工具结果和进程输出使用不同策略：该等待的等待，该截断的截断，该拒绝的明确失败。

~~~mermaid
flowchart TB
    M["模型流"] --> Q["256 events / 1 MiB<br/>满时等待"]
    Q --> C["文字合批<br/>25ms / 8KiB"]
    C --> T["CLI stdout<br/>write=false 等 drain"]
    P["Shell 输出"] --> D["磁盘配额<br/>32MiB 含索引"]
    D --> R["分页读取 / 有界结果"]
    R --> X["ContextManager<br/>预算 / 压缩"]
    X --> M
~~~

| 位置 | 当前上限或默认值 | 达到边界后的行为 |
| --- | --- | --- |
| 模型流事件队列 | 256 个事件、1 MiB；单事件不能超过 1 MiB | 生产者等待空间；超大单事件报错 |
| 文本与工具参数增量 | 每片最多 2,048 字符 | 限制一次事件的尺寸，不丢内容 |
| steering / follow-up | 每队列 4 项、合计 8,000 字符 | 拒绝新输入，保留已有队列 |
| 工具投影 | terminal 8 KiB；model 25 KiB / 2,000 行 | 归一化与截断，按契约读取完整输出 |
| Shell supervisor | 默认 8 个未退役任务记录 | 达到容量后拒绝新任务 |
| 进程输出落盘 | 默认 32 MiB，包含索引 | 记录超限信息，继续排空并丢弃超额输出 |
| 普通文件 read | 一次源内容最多 50 KiB | 分页；不同于模型投影上限 |
| 图片 | 单源 20 MiB / 4,000 万像素；规范化后 3 MiB | 拒绝或缩放；请求另限 8 张 / 16 MiB 编码数据 |

这些值分别属于不同单位：字符、UTF-8 字节、行和 token 不可互换；一条 2,048 字符的 CJK 文本可能远大于 2 KiB。表中默认值也不是整机内存的总上限。

## 为什么不能只有一个总开关

如果输出超限后停止读取子进程管道，子进程可能因管道写满而卡住，因此 supervisor 继续排空。如果把“取消”也塞进已满事件队列，取消就会等待消费；stream pump 用队列外的任务取消和完成唤醒解除这一依赖。

同样，低负载不意味着任何缓存都清零：Worker 仍保有受管任务、有限会话/任务缓存和连接；磁盘任务日志需要维护才能缩减。应从资源拥有者和退役条件分析上限，不能只看一个数组长度。

源码：[流式背压](../../../agent/runtime/core/stream_pump.py)、[CLI drain](../../../frontend-cli/lib/tui/tui.js)。机制与测试入口：[输入队列](../01-runtime/input-queues.zh-CN.md)、[结构化结果](../04-tools/tool-results.zh-CN.md)、[后台任务](../05-autonomy/managed-tasks.zh-CN.md)、[图片](../02-context/image-input.zh-CN.md)。验证：[流 pump](../../../test/test_stream_pump.py)、[运行时流](../../../test/test_runtime_stream_pump.py)。

[返回系列地图](../README.zh-CN.md)
