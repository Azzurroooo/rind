# CLI 一次 Turn 的运行流程

本文描述当前 Rind CLI 与 Runtime Worker 的实际结构。CLI 进程启动一个长期运行的 Runtime 子进程；Worker 按 `session_id` 路由请求。历史 session 不会被 Worker 长期缓存成运行对象，只有真正执行 turn 时才创建 active execution。

当前生命周期边界：

```text
Worker 进程长期运行
├── WorkerStdioRuntimeServer：JSONL ACP 传输、路由、事件封装
├── RuntimeWorker：Worker 级资源和服务所有者
│   ├── SessionRepository：按 session_id 读写持久化历史
│   ├── ExecutionCoordinator：只保存 active execution
│   └── SharedRuntimeResources：provider client、parser、normalizer、compaction service
└── active execution
    └── AgentContainer(session store + AgentRuntime + TurnRunner + tools)
```

`SessionRepository` 只负责持久化访问，不会为浏览历史创建 `AgentRuntime`。`ExecutionCoordinator` 只在 turn 运行期间保存对应的 `AgentContainer`，turn 终态后释放。

## 组件结构

```mermaid
flowchart TD
    CLI[CLI Surface\nrunFrontendCliApp]
    INPUT[Input Controller\nline editor / TTY UI]
    CONTROL[Turn Controller\nCommand Controller]
    CLIENT[Runtime Client\nrequest_id / pending requests]

    subgraph PROCESS[Runtime 子进程]
        SERVER[WorkerStdioRuntimeServer\nJSONL stdin/stdout\nACP dispatch / event writer]
        WORKER[RuntimeWorker\n应用级生命周期]
        REPO[SessionRepository\n按 session_id 读写历史]
        EXEC[ExecutionCoordinator\nactive session -> AgentContainer]
        SHARED[SharedRuntimeResources\nprovider / parser / normalizer / compaction]
        SERVER --> WORKER
        WORKER --> REPO
        WORKER --> EXEC
        WORKER --> SHARED
    end

    CLI --> INPUT --> CONTROL --> CLIENT
    CLIENT -- JSONL request --> SERVER
    SERVER -- JSONL response/event --> CLIENT
    CLIENT --> CONTROL --> INPUT

    classDef boundary fill:#e8f0ff,stroke:#4169a1,color:#111;
    classDef runtime fill:#eef8ee,stroke:#4f8a4f,color:#111;
    class CLI,INPUT,CONTROL,CLIENT boundary;
    class SERVER,WORKER,REPO,EXEC,SHARED runtime;
```

CLI 和 Runtime 是两个进程；`WorkerStdioRuntimeServer`、`RuntimeWorker`、`SessionRepository` 和 `ExecutionCoordinator` 都在同一个 Runtime 子进程内。Desktop 复用同一 Worker ACP 边界，但可以同时观察多个 session；CLI 通常只展示当前 session。

## Worker 内部构造

下面的图展示 Worker 启动后的长期对象、只读路径和 active turn 路径。`AgentContainer` 只位于 active execution 中，不属于 session 的长期缓存。

```mermaid
flowchart TB
    APP[app-server --stdio]
    WS[WorkerStdioRuntimeServer\nJSONL request / response / event]
    RW[RuntimeWorker\nWorker 生命周期]
    SR[SessionRepository\n按 session_id 访问持久化数据]
    EC[ExecutionCoordinator\nactive session -> AgentContainer]
    RES[SharedRuntimeResources]
    PC[共享 provider async client]
    PARSER[MessageStreamParser]
    NORMALIZER[ToolResultNormalizer]
    COMPACT[CompactionService]
    ACTIVE{active execution map}
    CONTAINER[AgentContainer\n仅 turn 期间存在]
    STORE[JsonlSessionStore\n指定 session_id]
    AR[AgentRuntime\nturn lock / queues / turn state]
    TR[TurnRunner\nsampling loop / tool steps]
    TOOLS[Tool Registry / Tool Executor]
    MODEL[OpenAIChatClient\n共享底层 client]
    FILES[JSONL messages / meta / tool records]

    APP --> WS --> RW
    RW --> SR
    RW --> EC
    RW --> RES
    RES --> PC
    RES --> PARSER
    RES --> NORMALIZER
    RES --> COMPACT
    EC --> ACTIVE --> CONTAINER
    CONTAINER --> STORE
    CONTAINER --> AR
    CONTAINER --> TR
    CONTAINER --> TOOLS
    CONTAINER --> MODEL
    AR --> STORE
    AR --> TR
    TR --> TOOLS
    TR --> MODEL
    STORE --> FILES
    SR --> FILES

    classDef process fill:#f4e8ff,stroke:#7048a8,color:#111;
    classDef worker fill:#e8f0ff,stroke:#4169a1,color:#111;
    classDef active fill:#fff3dd,stroke:#b7791f,color:#111;
    classDef storage fill:#eef8ee,stroke:#4f8a4f,color:#111;
    class APP,WS process;
    class RW,SR,EC,RES,PC,PARSER,NORMALIZER,COMPACT worker;
    class ACTIVE,CONTAINER,AR,TR,TOOLS,MODEL active;
    class STORE,FILES storage;
```

### Worker 内部职责

- `WorkerStdioRuntimeServer`：校验 ACP 请求、按 `session_id` 路由、管理 active server wrapper、发送 response 和 `session/update` event。
- `RuntimeWorker`：创建共享 provider client、repository 和 execution coordinator；负责 Worker 初始化与关闭。
- `SessionRepository`：读取 metadata、session list、replay、goal 和 model 等持久化状态；只读 replay 不创建执行对象。
- `ExecutionCoordinator`：在 prompt/compact 等需要执行的请求到达后创建 `AgentContainer`；turn 终态后释放。
- `SharedRuntimeResources`：保存无 session 可变状态的 provider client、stream parser、result normalizer 和 compaction service。
- `AgentRuntime`：active turn owner，负责 turn lock、turn_id、steering/follow-up、问题等待、持久化 turn 状态和终态。
- `TurnRunner`：执行 turn 内模型 sampling、流式解析、工具调用和步骤恢复；一次 turn 可以包含多次 sampling。
- `Tool Executor`：执行工具并按 `tool_call_id` 产生结果；不是独立进程。

## 启动时序

```mermaid
sequenceDiagram
    participant C as CLI
    participant P as Runtime 子进程
    participant S as WorkerStdioRuntimeServer
    participant W as RuntimeWorker
    participant R as SessionRepository
    participant E as ExecutionCoordinator

    C->>C: 读取本地 settings / CLI 参数
    C->>P: spawn app-server --stdio
    P->>S: 创建 WorkerStdioRuntimeServer
    S->>W: 创建 RuntimeWorker
    W->>W: 创建共享 provider client 和 SharedRuntimeResources
    W->>R: 创建 SessionRepository
    W->>E: 创建空的 ExecutionCoordinator
    C->>S: initialize(request_id)
    S->>W: initialize()
    W->>R: initial(workspace, session_id, resume_latest)
    R-->>W: session metadata
    S-->>C: initialize response(session_id, model, methods, commands)
    Note over C,E: Worker 常驻；此时没有任何 active AgentContainer
```

初始化只读取或创建 session metadata。打开历史 session、执行 `session/replay` 或切换 CLI 当前 session 都不会创建 `AgentContainer`。

## 一个普通 Turn

假设用户输入“检查测试失败原因”。

```mermaid
sequenceDiagram
    participant U as 用户
    participant I as Input Controller
    participant T as Turn Controller
    participant C as Runtime Client
    participant S as WorkerStdioRuntimeServer
    participant W as RuntimeWorker
    participant E as ExecutionCoordinator
    participant A as AgentRuntime
    participant R as TurnRunner
    participant M as Model API
    participant X as Tool Executor
    participant H as SessionRepository / JsonlSessionStore

    U->>I: 输入并按 Enter
    I->>T: submit(prompt)
    T->>C: session/prompt\n{session_id, input}
    C->>S: JSONL request + request_id
    S->>W: route(session_id)
    W->>E: start(session_id)
    E->>H: 读取 session metadata / workspace / model
    E->>E: 创建 active AgentContainer
    E->>A: initialize()
    S->>A: _run_turn()
    A->>A: 获取 turn lock，生成 turn_id
    A->>H: 持久化 user message + running turn state
    A-->>S: turn_started(session_id, turn_id)
    S-->>C: session/update
    C-->>T: 显示 Working

    loop TurnRunner sampling loop
        A->>R: run_turn(session, turn_id)
        R->>H: 读取历史并构建上下文
        R->>M: 发起一次模型流式请求
        M-->>R: assistant delta / tool request
        R-->>S: session/update(incremental)
        S-->>C: JSONL event
        C-->>T: 更新 assistant/tool UI

        opt 模型请求工具
            R->>X: 执行 tool_call_id
            X-->>R: tool progress / tool result
            R->>H: 持久化 tool call 和 result
            R-->>S: tool_result event
        end

        opt 有工具调用或 steering
            R->>R: 继续下一次 sampling
        end
    end

    A->>H: 持久化最终 turn state
    A-->>S: turn_completed / failed / cancelled
    S-->>C: session/update(terminal)
    S-->>C: session/prompt response
    S->>E: release(session_id)
    C-->>T: 清理 Working，恢复输入
```

`session/prompt` response 和 `turn_completed` event 是两条不同的输出：event 用于实时渲染，response 用于结束本次请求。CLI 不应把二者都当作新的 assistant 内容打印。

## Turn 内部循环

```mermaid
flowchart TD
    START[AgentRuntime.run_turn]
    LOCK[获取 turn lock\n生成 turn_id / running state]
    STEP[调用 TurnRunner.run_turn]
    CONTEXT[构建模型上下文]
    SAMPLE[一次模型 sampling]
    STREAM[assistant/tool/token 流式事件]
    TOOL{有 tool call?}
    EXEC[Tool Executor]
    RESULT[持久化 tool result]
    STEER{消费 steering?}
    NEXT[下一次 sampling]
    STEP_DONE[TurnRunner 产生 terminal event]
    FOLLOW{有 follow-up 或 active goal?}
    TURN_DONE[AgentRuntime 持久化终态并释放 execution]

    START --> LOCK --> STEP --> CONTEXT --> SAMPLE --> STREAM --> TOOL
    TOOL -- 是 --> EXEC --> RESULT --> STEER
    TOOL -- 否 --> STEER
    STEER -- 是 --> NEXT --> CONTEXT
    STEER -- 否 --> STEP_DONE
    STEP_DONE --> FOLLOW
    FOLLOW -- 是 --> STEP
    FOLLOW -- 否 --> TURN_DONE
```

工具结果不会直接结束 turn；结果进入历史和下一次模型上下文。一个 turn 可以进行多次 sampling，但只使用一个 `turn_id`。只有 AgentRuntime 确认没有 follow-up、active goal continuation 或未完成控制状态后，才发送终态并释放 active execution。

## 历史 replay 与活动 turn

`session/replay` 是只读 ACP 请求：

```text
WorkerStdioRuntimeServer
  -> RuntimeWorker.replay(session_id)
  -> SessionRepository.replay(session_id)
  -> messages + turn_state
  -> 若该 session 有 active execution，再附加 live_turn
```

`live_turn` 是 Worker 内存中的有界快照，只用于 surface 在切换 session 时恢复未落盘的 assistant 尾部、tool 状态、question、plan 和 pending input。它不写入历史，不启动新的 execution。

```mermaid
sequenceDiagram
    participant C as CLI/Desktop
    participant S as Worker Server
    participant W as RuntimeWorker
    participant R as SessionRepository
    participant E as Active execution

    C->>S: session/replay(session_id)
    S->>W: replay(session_id)
    W->>R: 读取持久化 messages / turn_state
    W->>E: 读取 live_turn（若 active）
    R-->>W: HistorySnapshot
    E-->>W: LiveTurnOverlay
    W-->>S: snapshot + live_turn
    S-->>C: response
```

surface 切换 session 不发送新的 prompt，不自动发送 `resume=true`，也不重复执行工具。Worker 仍存活时，切回页面可以继续接收同一 `session_id`、`turn_id` 的事件；Worker 已退出时只能恢复已持久化历史。

## Steering、Queue 与事件回传

普通输入：

```text
空闲 session -> session/prompt
active turn -> rind/session/steer 或 rind/session/follow_up
```

输入接纳和真正交付是两个阶段：

```text
rind/session/steer / rind/session/follow_up
  -> response(input_id, pending)
  -> turn loop 在步骤边界消费
  -> session/update(event.type = queued_input_delivered)
```

`input_id` 是队列实体身份；`queued_input_delivered` 才表示输入真正进入 turn。CLI 和 Desktop 都不应在收到“accepted/pending” response 时把它当作已交付消息。

## 多轮与多 Session

```mermaid
flowchart LR
    W[一个长期 RuntimeWorker]
    R[SessionRepository\n所有 session 持久化访问]
    E1[Active execution A\n仅 A turn 期间存在]
    E2[Active execution B\n仅 B turn 期间存在]
    H1[Session history A]
    H2[Session history B]
    W --> R
    W --> E1
    W --> E2
    R --> H1
    R --> H2
    E1 -. session_id=A .-> H1
    E2 -. session_id=B .-> H2
```

- 多轮对话：同一 session 的历史被 repository 持久化；每个新 turn 创建新的 `AgentContainer` 和新的 `turn_id`，不依赖上一个 turn 的常驻运行对象。
- 多 session：同一个 Worker 可以同时拥有 A、B 两个 active execution；它们共享 Worker 级 provider/parser 等无状态资源，但各自拥有 session store、turn lock、queue 和 AgentRuntime 状态。
- CLI session 切换：`/sessions` 通过 `rind/command/execute` 获取列表，再调用 `session/switch` 获取目标 metadata；切换不会重启 Worker，也不会创建 execution。
- Desktop session 切换：使用本地侧栏索引和 `session/replay`；不调用 `session/switch`。
- 取消 A：只调用带 A 的 `session/cancel`，不影响 B。

## 退出流程

```mermaid
sequenceDiagram
    participant C as CLI/Desktop
    participant S as WorkerStdioRuntimeServer
    participant E as Active executions
    participant W as RuntimeWorker
    participant P as Shared provider client

    C->>S: shutdown
    S->>E: interrupt all active turns
    S->>S: stop accepting requests
    S->>S: drain or cancel dispatch tasks
    S->>W: close()
    W->>E: release active containers
    W->>P: close shared provider client
    S-->>C: shutdown response
    S-->>C: process exits
```

历史文件不会因为 execution release 或正常 shutdown 被删除；只有已有的空 session 清理规则才会处理空记录。
