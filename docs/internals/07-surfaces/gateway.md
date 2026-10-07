# 消息网关：把聊天渠道折叠成会话事件

Gateway 将 Discord、Telegram、Slack 等渠道适配为统一 InboundMessage，再通过持久 session key 路由到 Worker。它拥有安全准入、去重和事件光标；工具细节不直接发到聊天频道。

~~~mermaid
flowchart TB
    C["渠道适配器"] --> P["pump"]
    P --> D["message_ref 去重"]
    D --> S["SecurityGate<br/>allowlist / pairing / group mention / cooldown"]
    S --> R["SessionRouter<br/>channel:type:chat[:thread]"]
    R --> W["Worker request + events"]
    W --> E["durable conversation events"]
    E --> O["渠道 outbound / reaction"]
    R --> F["state.json：session_id + cursor"]
~~~

相同渠道、chat_type、chat_id 和可选 thread_id 得到同一个 key；首次路由调用 session/new，失败只重试一次。光标只随 durable conversation event 前进，task_updated/task_output 快照不会挤占聊天历史。state.json 原子写入，损坏文件改名为 `.corrupt` 后从空映射启动。

在线入站顺序是 message_ref LRU 去重、准入判定、斜杠控制命令、待回答问题的数字答复、忙碌回合的 follow_up、最后才是新 prompt。DM 可由 allowlist 或 pairing 放行；群聊要求群在 group_allow 且文本 @ 提及 bot。配对码为六位无歧义字符，有待处理上限；放行的发送者还受冷却窗口约束。

事件 pump 维护 conversation cursor 与 reaction；有效数字选项优先用于回答待处理问题，其他文本仍走普通输入路由。Worker 离线时最多缓冲 100 条入站消息，超限丢弃最旧项，恢复后按序处理。渠道 SDK 按启用项惰性导入，stdio 传输关闭时先关 stdin、排空 stdout，最多等待 30 秒；WebSocket 关闭只结束连接。

## 配置入口

从源码启动时，可在一个终端运行 Worker，另一个终端运行向导和网关：

~~~sh
python main.py app-server --web --host 127.0.0.1 --port 8765 --cwd /absolute/path/to/project
~~~

~~~sh
python main.py gateway init --workspace /absolute/path/to/project
python main.py gateway --config /absolute/path/to/project/.rind/gateway.yaml
~~~

向导写入所选工作区的 .rind/gateway.yaml；渠道 SDK、平台账号和回调要求由相应适配器决定。Worker 启用认证时还需配置连接 token。`gateway doctor` 检查配置和依赖，`gateway approve <CODE>` 批准配对；两者应使用与运行实例相同的配置/工作区。

这里的 gateway/ 是消息渠道进程，与 Desktop 内部 HTTP/WebSocket Gateway 不同。前者把聊天消息转为会话输入，后者把同一个图形 Surface 暴露给远端设备。

源码：[路由](../../../gateway/router.py)、[pump](../../../gateway/pump.py)、[安全门](../../../gateway/security.py)、[传输](../../../gateway/transports.py)。验证：[路由](../../../test/test_gateway_router.py)、[安全](../../../test/test_gateway_security.py)、[pump](../../../test/test_gateway_pump.py)、[stdio 关闭](../../../test/test_gateway_stdio_shutdown.py)。

[返回系列地图](../README.md)
