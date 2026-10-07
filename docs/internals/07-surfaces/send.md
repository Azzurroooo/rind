# `rind send`：找到运行中的 CLI，再投递输入

send 的目标是一个正在运行的 CLI Surface，而不是裸 Worker 或“只要会话存在就能发送”。它先连接该 Surface 的本地 IPC listener，收到快速确认后由目标终端继续显示结果。

~~~mermaid
sequenceDiagram
    participant S as rind send
    participant I as 目标 CLI IPC
    participant C as CLI dispatch
    participant W as Worker
    S->>I: {input}（2 秒连接/确认）
    I-->>S: {ok, session_id}
    I->>C: dispatchExternal(input)
    C->>W: command 或 session/prompt
    W-->>C: 事件与回答
    C-->>I: 目标终端渲染
~~~

Windows 使用 `\\.\pipe\rind-<session>` 命名管道；Unix 使用 `$RIND_HOME/ipc/<session>.sock`。listener 启动时会探测 Unix 孤儿 socket，确认没有活跃服务才清理。空输入、非法 JSON 和关闭中的会话被拒绝。

确认表示输入已被目标进程接收，不表示模型完成。目标 CLI 先交给 command controller；普通文本再交给 turn controller：空闲时开启回合，忙碌时通过 sessionSteer 进入 steering 队列。结果和错误仍出现在目标终端。send 自身不复制 Worker 事件，也不接管会话所有权。

## 一个测试观察器的接入方式

~~~sh
rind send --session <id> "回归测试失败，请先检查最新错误。"
~~~

session ID 可从正在运行的 CLI 启动信息或 /status 获取。闲置时，目标 CLI 发起一次 prompt；正在采样时，普通文本进入 steering，等下一次采样前投递。以斜杠开头的输入还会经过目标 CLI 的命令处理，因此 send 是输入通道，不是只发送聊天正文的网络 API。

如果只在磁盘上保存了会话、对应 CLI 已退出，本地 IPC 端点就不可用；恢复保存会话应使用正常 CLI 或 run --session。接收确认在 dispatch 前立即返回，后续队列满、命令错误或执行失败仍由目标 Surface 显示，不能凭 send 的成功退出断言任务成功。

源码：[IPC listener/client](../../../frontend-cli/lib/ipc.js)、[外部 dispatch](../../../frontend-cli/lib/cli-input-actions.js)、[send 命令](../../../frontend-cli/lib/send.js)。验证：[IPC 测试](../../../frontend-cli/test/ipc.test.js)、[输入错误](../../../frontend-cli/test/input-errors.test.js)。

[返回系列地图](../README.md)
