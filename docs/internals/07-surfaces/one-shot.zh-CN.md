# `rind run`：一个请求作用域的 Surface

English | [简体中文](one-shot.md)

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

SIGINT 与 SIGTERM 会先取消本次回合再退出；SIGKILL 无法被捕获，回合会继续在共享 Runtime 中运行。在已注册成员的目录里，一次只允许一个运行，此时下一次 `rind run` 会失败并给出占用的运行 id 与 `rind agents stop <run>`（状态未知时为 `rind agents resolve <run> --confirm-stopped`）。自动化调用方超时时应先发 SIGTERM，等待几秒再 SIGKILL。

运行日志写在调用者当前目录的 logs 下，即使 `--dir` 指向另一工作区。一次运行与交互窗口共用同一个本地 Runtime：它的会话对所有窗口和 Agents 页可见，第二次运行直接复用已启动的宿主，因此运行结束后共享宿主照常保留；用 Background 页或 `rind agents stop` 停止它。使用 `--trace-llm`（宿主级追踪）时，本次运行保留自己的私有 worker；无论哪种情况，finally 阶段都会关闭客户端连接。

源码：[one-shot](../../../frontend-cli/lib/one-shot.js)、[进度输出](../../../frontend-cli/lib/one-shot-progress.js)。验证：[one-shot 测试](../../../frontend-cli/test/one-shot.test.js)、[被占用的成员目录](../../../frontend-cli/test/workspace-busy-journey.test.js)。关联：[任务通知](../05-autonomy/task-notifications.zh-CN.md)。

[返回系列地图](../README.zh-CN.md)
