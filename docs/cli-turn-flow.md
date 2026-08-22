# CLI 一次 Turn 的运行流程

本文描述当前 CLI 端的实际运行结构。当前实现采用一个 CLI 进程启动一个长期运行的 Runtime worker；worker 内部按 `session_id` 路由请求，每个 session 持有独立的 `AgentRuntime`、turn lock、队列和历史存储。

`SessionRuntime` 是 worker 内缓存的 session 容器。它在 session 被打开后保留在 `SessionRegistry` 中，但没有 active turn 时不会自行运行；只有收到 prompt 或控制请求时，才调用其中的 `AgentRuntime`。

## 组件结构

```mermaid
flowchart TD
    CLI[CLI Surface\nrunFrontendCliApp]
    INPUT[Input Controller\nLine Editor / TTY UI]
    CTRL[Turn Controller\nCommand Controller]
    CLIENT[Runtime Client\nrequest_id / pending requests]

    subgraph PROCESS[Runtime 子进程]
        SERVER[WorkerStdioRuntimeServer\nJSONL stdin/stdout\nrequest dispatch / event writer]
        WORKER[RuntimeWorker\n应用级生命周期]
        REGISTRY[SessionRegistry\nsession_id -> SessionRuntime]
        SERVER --> WORKER --> REGISTRY

        subgraph SESSIONS[Session Runtime 集合]
            SESSION_A[SessionRuntime A\nsession_id = A]
            SESSION_B[SessionRuntime B\nsession_id = B]
            SESSION_N[SessionRuntime N\nsession_id = N]
        end
        REGISTRY --> SESSION_A
        REGISTRY --> SESSION_B
        REGISTRY --> SESSION_N

        subgraph SESSION_RUNTIME[单个 SessionRuntime]
            STORE[JsonlSessionStore\nhistory / meta / turn state]
            subgraph TURN_ENGINE[Session Turn Engine]
                RUNTIME[AgentRuntime\nTurn 生命周期 / lock / queues]
                RUNNER[TurnRunner\nsampling / stream / tool steps]
                RUNTIME --> RUNNER
            end
            TOOLS[Tool Registry + Executor]
            MODEL[OpenAI Chat Client]
            RUNTIME --> STORE
            RUNNER --> TOOLS
            RUNNER --> MODEL
        end
        SESSION_A -. owns .-> SESSION_RUNTIME
    end

    CLI --> INPUT --> CTRL --> CLIENT
    CLIENT -- JSONL request --> SERVER
    SERVER -- JSONL response/event --> CLIENT
    CLIENT --> CTRL --> INPUT

    classDef boundary fill:#e8f0ff,stroke:#4169a1,color:#111;
    classDef runtime fill:#eef8ee,stroke:#4f8a4f,color:#111;
    class CLI,INPUT,CTRL,CLIENT boundary;
    class SERVER,WORKER,REGISTRY,SESSION_A,SESSION_B,SESSION_N,STORE,RUNTIME,RUNNER,TOOLS,MODEL runtime;
```

图中的 `SessionRuntime A/B/N` 是同一 worker 管理的多个 session。当前实现中，每个 session 的 `AgentContainer` 内包含自己的 `AgentRuntime` 和 `TurnRunner`；同一 session 的多次对话复用这些对象，但每一轮拥有新的 `turn_id`。

这些组件都位于同一个 Runtime 子进程中，不是多个子进程：

```text
Runtime 子进程
├── WorkerStdioRuntimeServer 传输和请求路由
└── RuntimeWorker 应用级生命周期
    └── SessionRegistry
        └── SessionRuntime（按 session_id 缓存）
```

## 启动时序

```mermaid
sequenceDiagram
    participant C as CLI
    participant P as Runtime 子进程
    participant S as WorkerStdioRuntimeServer
    participant W as RuntimeWorker
    participant R as SessionRegistry
    participant A as SessionRuntime A

    C->>C: 读取 ~/.rind/settings.json
    C->>P: spawn main.py app-server --stdio
    P->>S: 创建 JSONL server
    S->>W: 创建 RuntimeWorker
    W->>R: 创建 SessionRegistry
    C->>S: initialize(request_id)
    S->>W: initialize()
    W->>R: initial(workspace, session_id/resume_latest)
    R->>A: create/open SessionRuntime
    A->>A: AgentRuntime.initialize()
    S-->>C: initialize response(session_id, model, methods)
    Note over C,A: worker/server 保持常驻，等待后续请求
```

## 一个普通 Turn

假设用户输入 `检查测试失败原因`。

```mermaid
sequenceDiagram
    participant U as 用户
    participant I as Input Controller
    participant T as Turn Controller
    participant C as Runtime Client
    participant S as WorkerStdioRuntimeServer
    participant W as RuntimeWorker
    participant R as SessionRegistry
    participant SR as SessionRuntime A
    participant A as AgentRuntime A
    participant TR as TurnRunner
    participant M as Model API
    participant X as Tool Executor
    participant H as Session Store

    U->>I: 输入并按 Enter
    I->>T: submit("检查测试失败原因")
    T->>C: session/prompt\n{session_id: A, input: ...}
    C->>S: JSONL request + request_id
    S->>W: dispatch(session/prompt)
    W->>R: resolve(session_id=A)
    R-->>W: SessionRuntime A
    W-->>S: SessionRuntime A
    S->>SR: _run_turn()
    SR->>A: run_turn()
    A->>A: 获取 turn lock，生成 turn_id
    A->>H: 持久化 user message
    A->>H: 持久化 running turn state
    A-->>S: turn_started(session A, turn X)
    S-->>C: session/update event
    C-->>T: 更新 CLI Working 状态

    loop Turn loop / model steps
        A->>H: 读取历史并组装上下文
        A->>TR: run_turn(session, turn_id, take_steering)
        TR->>M: 发起模型流式请求
        M-->>TR: assistant_delta / tool request
        TR-->>A: 流式 runtime event
        A-->>S: session/update(session A, turn X)
        S-->>C: JSONL event
        C-->>T: 渲染 assistant/tool 输出

        opt 模型请求工具
            TR->>X: 执行工具
            X-->>TR: tool result
            TR-->>A: tool_result
            A->>H: 持久化工具调用和结果
        end
    end

    A->>H: 持久化最终 turn state
    A-->>S: turn_completed(session A, turn X)
    S-->>C: session/update(turn_completed)
    S-->>C: session/prompt response(ok, session_id, turn_id)
    C-->>T: 清理 Working，恢复输入
```

## SessionRuntime、AgentRuntime 和 TurnRunner

三者的关系是：

```text
SessionRuntime
└── AgentContainer
    ├── AgentRuntime：session 级 turn 生命周期、锁和队列
    ├── TurnRunner：一次模型/工具执行步骤
    ├── ToolExecutor：执行具体工具
    └── SessionStore：历史、meta 和 turn state
```

`AgentRuntime` 和 `TurnRunner` 共同组成一个 session 的 `Session Turn Engine`。`AgentRuntime` 是外层 owner，负责锁、turn 状态、用户输入持久化、终态持久化以及 follow-up/goal continuation；`TurnRunner.run_turn()` 是其中的 sampling/工具执行器，自身包含模型 sampling 的内部循环。因此，当前代码不是“一个 TurnRunner 对象只执行一次 sampling”，而是“一个 Turn Engine 管理完整 Turn，其中 TurnRunner 内部可能执行多次 sampling”。`ToolExecutor` 是 `TurnRunner` 的依赖对象，不是独立进程。

## Turn 内部循环

`AgentRuntime.run_turn()` 和 `TurnRunner.run_turn()` 是两层循环：

```mermaid
flowchart TD
    OUTER_START[AgentRuntime.run_turn 开始]
    LOCK[获取 session turn lock\n生成 turn_id 并持久化 running state]
    RUNNER[调用 TurnRunner.run_turn]
    INNER[TurnRunner 内部 sampling loop]
    TERMINAL{TurnRunner 是否完成?}
    FOLLOW{有 follow-up 或 active goal?}
    OUTER_CONTINUE[AgentRuntime 再次调用 TurnRunner]
    DONE[持久化最终状态\n清理 active_turn]
    FAIL[持久化 failed/cancelled\n清理 active_turn]

    OUTER_START --> LOCK --> RUNNER --> INNER --> TERMINAL
    TERMINAL -- 是 --> FOLLOW
    FOLLOW -- 是 --> OUTER_CONTINUE --> RUNNER
    FOLLOW -- 否 --> DONE
    RUNNER -. 异常或取消 .-> FAIL

    subgraph INNER_LOOP[TurnRunner.run_turn 的内部循环]
        CONTEXT[构建上下文]
        SAMPLE[一次模型 sampling]
        EVENTS[转发 assistant/tool/token/file 事件]
        TOOLS{是否有工具调用?}
        EXEC[ToolExecutor 执行工具]
        RESULT[持久化 tool result\n放回模型上下文]
        STEER[步骤边界消费 steering]
        NEXT[继续下一次 sampling]
        INNER_DONE[无工具且无 steering\n产生 TurnCompleted]

        CONTEXT --> SAMPLE --> EVENTS --> TOOLS
        TOOLS -- 是 --> EXEC --> RESULT --> STEER --> NEXT --> CONTEXT
        TOOLS -- 否 --> STEER
        STEER --> NEXT
        STEER -. 无 steering .-> INNER_DONE
    end
```

工具执行完成后不会直接结束 turn。工具结果会先被持久化，并重新放入模型上下文，由 `TurnRunner` 发起下一次 sampling。只有 `TurnRunner` 内部确认没有工具调用和 steering 后，才产生该执行段的 `TurnCompleted`；随后 `AgentRuntime` 还会检查 follow-up 或 active goal continuation。只有两者都没有时，才会持久化整个 turn 的最终状态并清理 `active_turn`。

这里的“多次模型请求”仍属于同一个 turn；只有 turn 结束后，下一次用户输入才会创建新的 `turn_id`。

## Steering、Queue 和事件回传

普通输入在没有 active turn 时调用：

```text
session/prompt
```

active turn 期间，CLI 的 steer 请求调用：

```text
rind/session/steer
```

请求必须携带当前 `session_id` 和 `turn_id`。worker 校验通过后返回 `input_id` 和 `pending`，但这只代表输入已进入队列。

真正被 turn loop 消费时，worker 发出：

```text
queued_input_delivered
```

CLI 以该事件作为“已出队、已交给 turn loop”的权威依据。follow-up queue 使用 `rind/session/follow_up`，在当前模型步骤完成后进入下一步。

## 多轮与多 Session

```mermaid
flowchart LR
    W[一个长期 RuntimeWorker]
    A[Session A\nAgentRuntime A\nturn-1 -> turn-2 -> turn-3]
    B[Session B\nAgentRuntime B\nturn-7 -> turn-8]
    W --> A
    W --> B
    A -. 独立 history / queue / lock .- B
```

- 多轮对话：复用同一个 session 的 `AgentRuntime` 和 `TurnRunner`，每次重新进入 `run_turn()`，生成新的 `turn_id`。
- 多 session：由同一个 worker 管理，但通过不同 `session_id` 找到不同的 `SessionRuntime`。CLI 同一时刻只有一个当前 session；多个 session 是底层 Registry 的管理能力，主要用于 `/sessions` 切换和复用，Desktop 才会同时展示多个 session。
- session 切换：CLI 更新当前 `session_id`；不会重新启动 worker。
- turn 取消：调用 `session/cancel`，并携带当前 `turn_id`；不会影响其他 session。

## 退出流程

```mermaid
sequenceDiagram
    participant C as CLI
    participant S as WorkerStdioRuntimeServer
    participant W as RuntimeWorker
    participant A as Active Session Runtimes

    C->>S: shutdown
    S->>A: interrupt active turns
    S->>S: stop accepting requests
    S->>S: drain or cancel dispatch tasks
    S->>W: close()
    W->>W: close provider client
    W->>W: discard empty sessions
    S-->>C: shutdown response
    S-->>C: process exits
```
