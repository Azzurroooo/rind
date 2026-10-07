# `rind run`：一个请求作用域的 Surface

one-shot 把交互式 CLI 的事件流压成一次命令：最终答案只写 stdout，阶段性助手文本、工具与任务进度写 stderr，并在请求作用域内等待关联后台任务完成或交付。

~~~mermaid
sequenceDiagram
    participant P as shell
    participant O as one-shot
    participant W as Worker
    P->>O: run --prompt --dir [--session]
    O->>W: request completion_scope=request
    W-->>O: assistant/task events
    O-->>P: progress -> stderr
    W->>W: 等待本请求 on_exit / continuation
    W-->>O: response.answer
    O-->>P: answer -> stdout（一次）
    O->>W: shutdown
~~~

启动参数要求 prompt，可指定绝对 workspace 和 session；Worker 以 `--no-user-question` 运行。初始化若公布 rind/request-completion 能力，CLI 在 prompt 请求中发送 completion_scope=request；若没有该能力，CLI 显示兼容警告并退回单回合等待。等待关联任务由 Worker 完成，不需要 CLI 反复查询所有进程。

请求作用域记录本次 request_id 创建的任务，不会把旧会话遗留任务误算进来；当没有忙碌回合、关联 on_exit 任务和可交付通知时才结束。任务失败先作为模型可见通知交付，因此单个 shell 非零退出不会自动等价于 one-shot 失败；请求中断、模型失败或最终 shutdown 失败会使命令返回非零。

运行日志写在调用者当前目录的 logs 下，即使 `--dir` 指向另一工作区。finally 阶段关闭客户端，避免 one-shot 留下后台服务。

源码：[one-shot](../../../frontend-cli/lib/one-shot.js)、[进度输出](../../../frontend-cli/lib/one-shot-progress.js)。验证：[one-shot 测试](../../../frontend-cli/test/one-shot.test.js)。关联：[任务通知](../05-autonomy/task-notifications.md)。

[返回系列地图](../README.md)
