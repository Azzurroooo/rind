# 事件系统：把执行事实变成界面更新

English | [简体中文](event-system.md)

内核产出 RuntimeEvent；协议层只给它统一封装。界面订阅的是“发生了什么”，不需要读取 Python 对象或反复轮询会话文件。

~~~mermaid
flowchart LR
    RUN["TurnRunner / ToolProcessor"] --> EV["domain RuntimeEvent"]
    TASK["任务观察者"] --> EV
    EV --> DISP["RuntimeDispatcher"]
    DISP --> ENV["session/update<br/>sequence · durability · session_id · turn_id"]
    ENV --> UI["CLI / Desktop / Web / Gateway"]
    STORE[("消息与工具记录")] --> REPLAY["durable 事件重建"]
    REPLAY --> ENV
~~~

assistant_delta、tool_input_delta、tool_progress 等增量事件用于即时展示；turn_started、assistant_message_completed、tool_requested、tool_result 和终态等属于 durable 类。任务更新跨回合到达，使用空 turn_id 和原始 origin_turn_id，不会把旧回合重新激活。Dispatcher 按连接维护序号，并只把会话事件发给已订阅的连接。

事件不是第二份持久数据库。会话保存消息、工具记录与回合状态；重连时从这些事实投影 durable 事件。这个区分让实时界面可以丰富，而磁盘模型仍简单。

## 相似名字，三种不同依据

| 字段或分类 | 解决的问题 | 不能代替 |
| --- | --- | --- |
| sequence | 当前连接中事件的发送顺序 | 对话持久光标 |
| event_id | 一次事件的身份；任务完成通知可用稳定 ID 去重 | 会话或回合 ID |
| durability | 是否属于可恢复的关键进度 | 证明每个事件都写入独立事件文件 |

例如工具请求发出后界面可立即展开工具块，但真正完成要看 tool_result 与持久记录。Task 的终态又可在原 turn 结束后抵达，所以它保留来源 turn，而不把已经结束的回合重新标成运行中。事件封装统一，业务寿命仍由事件类型决定。

代码入口：[事件类型](../../../agent/domain/events.py)、[协议封装](../../../agent/runtime/server/protocol.py)、[重放投影](../../../agent/runtime/server/replay_events.py)。验证：[事件测试](../../../test/test_runtime_events.py)、[订阅测试](../../../test/test_runtime_server_subscriptions.py)。

[返回系列地图](../README.zh-CN.md)
