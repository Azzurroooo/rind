# Rind 主流程与运行时数据流

> 本文描述当前实现从 CLI/API 启动、构建 runtime，到一次 turn、工具循环、持久化、取消和退出的完整路径。它与 `docs/architecture.md` 的关系是：architecture 说明静态结构，本文件说明时间顺序和状态变化。

## 1. 入口总览

```mermaid
flowchart TD
    User["用户"]
    Main["main.py"]
    Args["argparse\n--version --debug --session -c --session-dir --doctor"]
    Doctor["build_doctor_report()"]
    Validate["validate_session_id()"]
    Config["Config.ensure_user_settings_template()\nConfig.reload()\nvalidate_settings()"]
    Build["build_agent_container()"]
    CLI["ChatCLI(runtime, session, debug).start()"]
    Exit0["return 0"]
    Exit1["return 1\nconfiguration/session/doctor error"]
    Exit130["return 130\nKeyboardInterrupt"]

    User --> Main --> Args
    Args -->|--doctor| Doctor --> Exit1
    Args -->|normal mode| Validate --> Config --> Build --> CLI
    Config -->|ValueError| Exit1
    Validate -->|invalid id| Exit1
    CLI -->|normal exit| Exit0
    CLI -->|Ctrl+C| Exit130
```

`--doctor` 在构建完整 Agent 之前执行诊断并退出；普通启动才会初始化 settings、构建 container 和 CLI。`main.py` 当前直接把 `container.runtime` 与 `container.session_store` 传给 `ChatCLI`。

## 2. frontend-cli / ts_cli 启动全流程

仓库没有单独的 `ts_cli` 实现；当前对应的终端入口是 `frontend-cli/bin/rind.js`。它与 `python main.py` 是两条不同的启动路径：前者负责 Node 终端体验，后者负责 Python CLI；`frontend-cli` 的交互模式通过 stdio runtime 子进程复用 Python 应用核心。

```mermaid
sequenceDiagram
    autonumber
    participant Shell as Shell / npm bin
    participant Node as frontend-cli/bin/rind.js
    participant Env as runtime-env.js
    participant Py as Python child process
    participant Stdio as agent.interfaces.runtime_server.stdio
    participant Protocol as JSONL protocol
    participant TTY as terminal-ui / readline
    participant Render as state + rendering modules

    Shell->>Node: node bin/rind.js [args]
    Node->>Node: resolve scriptDir, repoRoot, RIND_PYTHON

    alt --help / --version / -h
        Node->>Env: buildRuntimeEnv(repoRoot)
        Node->>Py: spawnSync(python, main.py, stdio=inherit)
        Py-->>Shell: help/version + exit code
    else interactive runtime
        Node->>Env: buildRuntimeEnv(repoRoot)
        Env-->>Node: PYTHONPATH + UTF-8 environment
        Node->>Py: spawn(python, -c runtimeBootstrap, cliArgs)
        Note over Node,Py: stdin=pipe, stdout=pipe, stderr=pipe
        Py->>Stdio: runpy.run_module(...stdio, __main__)
        Stdio-->>Node: process stdout JSONL
        Stdio-->>Node: process stderr diagnostics
        Node->>Node: attach line buffer, exit handler, SIGINT handler
        Node->>Protocol: request(initialize)
        Protocol->>Stdio: {request_id, method, params}\nJSONL line
        Stdio-->>Protocol: initialize result + capabilities + resume preview
        Protocol-->>Node: sessionInfo / slash commands
        alt process.stdin.isTTY && process.stdout.isTTY
            Node->>TTY: createTerminalUI().start()
            TTY-->>Node: key/paste events
        else non-TTY
            Node->>TTY: createInterface(readline)
            TTY-->>Node: line/data events
        end
        Node->>Render: startupText(info)
        Node->>Node: promptLoop()
    end
```

### 2.1 Python child 的启动细节

`rind.js` 不执行 `python main.py` 进入交互模式，而是构造一段 `runtimeBootstrap`：

```python
import os, runpy, sys
repo = os.path.abspath(REPO_ROOT)
cwd = os.path.abspath(os.getcwd())
blocked = {os.path.normcase(repo), os.path.normcase(cwd)}
sys.path = [repo] + [p for p in sys.path if p and os.path.normcase(os.path.abspath(p)) not in blocked]
runpy.run_module("agent.interfaces.runtime_server.stdio", run_name="__main__")
```

这样做的作用是：

- 以仓库根目录作为 Python import 根；
- 从 `sys.path` 中去掉可能遮蔽仓库模块的 repo/cwd 项；
- 直接启动 JSONL `StdioRuntimeServer`，不启动 Python `ChatCLI`；
- 将 Node 终端 UI 与 Python AgentRuntime 解耦。

### 2.2 stdio server 子进程启动

```mermaid
sequenceDiagram
    autonumber
    participant Child as Python child
    participant Main as stdio.main()
    participant Args as build_parser()
    participant Config as Config
    participant Container as build_agent_container()
    participant Server as StdioRuntimeServer
    participant Store as SessionStore

    Child->>Main: module __main__
    Main->>Main: configure_stdio_server_signals()
    Main->>Main: configure_utf8_stdio()
    Main->>Args: parse --debug/--session/-c/--session-dir
    Args-->>Main: runtime server args
    Main->>Main: validate_session_id(session)
    Main->>Config: ensure template -> reload -> validate
    Config-->>Main: AppSettings
    Main->>Container: build_agent_container(enable_goal=True)
    Container-->>Main: AgentContainer
    Main->>Server: runtime + session + model factory + background callbacks
    Server->>Server: run()\nread JSONL stdin and dispatch requests
    Server-->>Main: exit code
    Main->>Store: discard_if_empty() in finally
    Main-->>Child: return code
```

这一步与 Python `main.py` 的 CLI 启动不同：stdio server 不创建 `ChatCLI`，而是把 `container.runtime` 交给 `StdioRuntimeServer`；同时默认启用 goal 能力，并注册 background task list/output 回调。

### 2.3 stdio 管道和 request multiplex

```mermaid
flowchart LR
    NodeRequest["rind.js request(method, params)"]
    Pending["pending: Map<request_id, resolve/reject>"]
    JSONOut["JSON.stringify(request) + \\n"]
    PyIn["Python stdin"]
    Server["StdioRuntimeServer\nrequest reader + dispatcher"]
    PyOut["Python stdout JSONL"]
    Buffer["runtimeStdoutBuffer\n按换行拆分完整消息"]
    Receive["receive(line)"]
    Response["response request_id\nresolve pending"]
    Event["event envelope\nsequence/durability/type"]
    State["turn/tool/plan/background state"]
    UI["rendering + terminal frame"]

    NodeRequest --> Pending --> JSONOut --> PyIn --> Server
    Server --> PyOut --> Buffer --> Receive
    Receive --> Response --> Pending
    Receive --> Event --> State --> UI
```

request response 与 event 共用 stdout；`request_id` 只用于匹配 response，event 通过 `event_type` 或 `event.type` 分发。Node 端必须保留未完整接收的尾行，防止一次 data chunk 恰好落在 JSONL 行中间。

### 2.4 frontend-cli 进入 prompt loop 后的状态

```mermaid
stateDiagram-v2
    [*] --> Spawned: Python child spawned
    Spawned --> Initializing: request(initialize)
    Initializing --> PromptReady: result + startup render
    PromptReady --> ReadingInput: TTY UI / readline
    ReadingInput --> PromptReady: empty input / local command
    ReadingInput --> TurnActive: turn.start
    ReadingInput --> ControlRequest: slash / model / session / goal
    ControlRequest --> PromptReady: result rendered
    TurnActive --> ToolActive: tool_started/requested
    ToolActive --> QuestionActive: user_question_requested
    QuestionActive --> ToolActive: user_question.respond
    ToolActive --> TurnActive: tool_result / continuation
    TurnActive --> PromptReady: turn_completed
    TurnActive --> PromptReady: turn_failed / turn_cancelled
    TurnActive --> TurnActive: turn.follow_up / steering
    ReadingInput --> ShuttingDown: SIGINT / EOF
    TurnActive --> ShuttingDown: SIGINT -> turn.interrupt
    PromptReady --> ShuttingDown: exit / runtime shutdown
    ShuttingDown --> [*]: close stdin, end pipe, kill fallback, exit code
```

## 3. 启动与依赖组装顺序

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户/进程
    participant Main as main.py
    participant Args as argparse
    participant Config as Config
    participant Factory as OpenAIClientFactory
    participant Store as JsonlSessionStore
    participant Tools as Registry/Executor/Processor
    participant Context as ContextManager
    participant Runner as TurnRunner
    participant Runtime as AgentRuntime
    participant CLI as ChatCLI

    User->>Main: python main.py [args]
    Main->>Args: parse_args()
    Args-->>Main: debug/session/resume/session_dir/doctor

    alt --doctor
        Main->>Main: build_doctor_report()
        Main-->>User: report.text + exit code
    else normal startup
        Main->>Main: validate_session_id(session)
        Main->>Config: ensure_user_settings_template()
        Main->>Config: reload()
        Main->>Config: validate_settings(settings)
        Config-->>Main: AppSettings

        Main->>Factory: create(settings)
        Main->>Store: JsonlSessionStore(session_dir, session_id, resume_latest)
        Main->>Tools: TOOL_SPECS -> DefaultToolRegistry -> ToolExecutor
        Tools->>Tools: ToolResultNormalizer + ToolCallProcessor
        Main->>Factory: create_async_client()
        Main->>Context: ContextEstimator + SkillRepository + SkillSelector + RIND provider
        Main->>Runner: MessageStreamParser + ContextManager + CompactionService
        Runner->>Runtime: AgentRuntime(turn_runner, session_store, goal_enabled)
        Main->>CLI: ChatCLI(runtime, session, debug)
        CLI-->>User: prompt / startup preview
    end
```

### Container 内的对象连接

```mermaid
flowchart LR
    Settings["AppSettings"] --> Factory["OpenAIClientFactory"] --> Client["OpenAIChatClient"]
    Store["JsonlSessionStore"] --> Runtime["AgentRuntime"]
    Registry["DefaultToolRegistry"] --> Executor["ToolExecutor"] --> Processor["ToolCallProcessor"]
    Processor --> Runner["TurnRunner"]
    Client --> Runner
    Parser["MessageStreamParser"] --> Runner
    Context["ContextManager"] --> Runner
    Compact["CompactionService"] --> Runner
    Runner --> Runtime
```

## 4. CLI 交互循环

```mermaid
sequenceDiagram
    participant User as 用户
    participant CLI as ChatCLI
    participant Commands as SlashCommandRouter
    participant Runtime as AgentRuntime
    participant UI as StreamingRenderer/StatusRenderer
    participant Input as Question responder

    loop interactive prompt
        CLI->>User: 显示 prompt、model、cwd、状态
        User->>CLI: 文本输入或 /command
        alt slash command
            CLI->>Commands: parse + dispatch
            alt readonly command
                Commands-->>CLI: immediate display payload
            else turn/control command
                Commands->>Runtime: compact/model/session/goal 或 turn request
            end
            CLI->>UI: render command result
        else normal input
            CLI->>Runtime: run_turn(query)
            Runtime-->>CLI: RuntimeEvent stream
            CLI->>UI: render event
            alt ask_user_question
                Runtime-->>Input: question event
                Input-->>Runtime: answer response
            end
        end
    end
```

前端 `frontend-cli/bin/rind.js` 是另一条 CLI 外壳：它启动 Python stdio runtime 子进程，发送 JSONL request，使用 `runtime-protocol.js` 解析 envelope，并将事件交给输入状态、后台任务状态和 `rendering.js`。

## 5. 一次普通 turn 的完整时序

```mermaid
sequenceDiagram
    autonumber
    participant CLI as ChatCLI / frontend-cli
    participant Runtime as AgentRuntime
    participant Store as SessionStore
    participant Runner as TurnRunner
    participant Context as ContextManager
    participant LLM as OpenAIChatClient
    participant Pump as stream_pump
    participant Processor as ToolCallProcessor
    participant Executor as ToolExecutor
    participant Tool as builtin tool
    participant UI as event renderer

    CLI->>Runtime: run_turn(query, cancellation_token)
    Runtime->>Runtime: acquire turn lock\nset active_turn_id / accepting_inputs
    Runtime->>Store: initialize()
    Runtime->>Store: persist_message(user, query)
    Runtime-->>UI: turn_started
    Runtime->>Runner: run_turn(session, turn_id)

    loop model/tool continuation
        Runner->>Context: resolve active skills
        Context->>Store: list messages + metadata
        Context->>Context: inject system/RIND/skills/transient messages
        Context->>Context: estimate tokens and compute decisions
        Context-->>Runner: ContextBuildResult
        Runner-->>UI: context_built / skill_activated

        alt compact required
            Runner->>Context: run compact(reason, phase)
            Context->>Store: read history + persist compaction/handoff
            Context-->>Runner: rebuilt context
            Runner-->>UI: context_built
        end

        Runner->>LLM: stream(messages, tool_schemas)
        loop provider chunks
            LLM-->>Pump: chunk
            Pump->>Runner: assistant_delta / tool_input_delta
            Runner-->>UI: incremental event
        end

        alt assistant message without tools
            Runner->>Store: persist_message(assistant)
        else assistant requests tools
            Runner->>Store: persist_message(assistant tool call)
            Runner-->>UI: tool_requested
            Runner->>Processor: process_tool_calls(tool calls)
            loop each tool call
                Processor-->>UI: tool_started
                Processor->>Executor: execute_tool(name, args)
                Executor->>Tool: invoke
                Tool-->>Executor: result/error
                Executor-->>Processor: normalized ToolResult
                alt ask_user_question
                    Processor-->>CLI: question event
                    CLI-->>Processor: answer
                end
                Processor->>Store: persist_tool_call()
                Processor->>Store: persist_message(tool result)
                Processor-->>Runner: tool_result / file_changed
                Runner-->>UI: event
            end
        end
    end

    Runner->>Store: persist sampling usage
    Runner-->>Runtime: turn_completed / failed / cancelled
    Runtime->>Store: persist_turn_state(terminal event)
    alt follow-up queued
        Runtime->>Store: persist_message(user follow-up)
        Runtime->>Runner: continue next turn cycle
    else active goal continuation
        Runtime->>Runner: continue with goal prompt
    else terminal
        Runtime-->>CLI: terminal event
        Runtime->>Runtime: clear active turn and queues
    end
```

## 6. 上下文、compact 和错误恢复

```mermaid
flowchart TD
    Build["ContextManager.build_context()"]
    History["SessionStore.list_messages()"]
    Docs["RIND docs provider"]
    Skills["SkillSelector + SkillRepository"]
    Estimate["ContextEstimator / ContextBudget"]
    Decision["stats + decisions"]
    Compact["CompactionService"]
    Handoff["compact handoff / summary / boundary"]
    Rebuild["rebuild context"]
    Stream["LLM stream"]
    Error["ProviderError / BadRequestError\ncontext_length_exceeded"]
    Rescue["reduce hard limit\nforce rescue next build"]

    Build --> History
    Build --> Docs
    Build --> Skills
    Build --> Estimate
    History --> Decision
    Docs --> Decision
    Skills --> Decision
    Estimate --> Decision
    Decision -->|compact_required| Compact
    Compact --> Handoff --> Rebuild --> Stream
    Decision -->|within budget| Stream
    Stream --> Error
    Error -->|first occurrence| Compact
    Error -->|repeated| Rescue --> Build
```

恢复顺序是：第一次 context length error 触发 mid-turn compact；再次失败则降低 context hard limit，并要求下一次 build 走 rescue。非 context length 的 provider error 直接转换为 `turn_failed`。

## 7. 工具执行与持久化顺序

```mermaid
sequenceDiagram
    participant Runner as TurnRunner
    participant Processor as ToolCallProcessor
    participant Executor as ToolExecutor
    participant Registry as DefaultToolRegistry
    participant Builtin as shell/files/web/skill/goal/planning/question
    participant Store as SessionStore
    participant Event as RuntimeEvent stream

    Runner->>Processor: process_tool_calls()
    Processor->>Registry: resolve tool name
    Registry-->>Executor: ToolSpec / callable
    Processor->>Executor: execute(args)
    Executor->>Builtin: invoke sync or async tool
    Builtin-->>Executor: ToolResult / error
    Executor-->>Processor: normalized result
    Processor->>Store: persist_tool_call(call, result)
    Processor->>Store: persist_message(tool result)
    Processor-->>Event: tool_started / progress / result
    Processor-->>Event: file_changed or user_question when applicable
    Event-->>Runner: result becomes next context input
```

内置工具目录：

- `builtin/shell/`：`tool.py`、`session_pool.py`、`supervisor.py`、`process.py`、`capture.py`、`policy.py`、`process_tree.py`、`result.py`；
- `builtin/files/`：文件读取、写入、编辑和变更记录；
- `builtin/web.py`：网络检索/访问工具；
- `builtin/skill.py`：技能查询和激活；
- `builtin/goal.py`、`builtin/planning.py`：goal/plan 控制；
- `builtin/user_question.py`：将用户问答桥接到 runtime responder。

## 8. Session、控制请求和退出

```mermaid
flowchart LR
    Request["CLI slash / API / stdio request"]
    Router["runtime request router / CLI router"]
    Runtime["AgentRuntime"]
    Store["JsonlSessionStore"]
    State["session meta\nmodel · goal · turn state · usage"]
    History["JSONL history\nmessages/tool_calls/compactions"]
    Terminal["terminal response/event"]

    Request --> Router --> Runtime
    Runtime --> Store
    Store --> State
    Store --> History
    Runtime --> Terminal
```

控制请求的主要行为：

| 请求 | runtime 行为 | 是否进入主 turn 队列 |
| --- | --- | --- |
| `initialize` | 初始化 session、返回 resume preview/capabilities | 否 |
| `turn.start` | 启动一次 turn | 是 |
| `turn.interrupt` | 取消 token、丢弃 pending input | 否 |
| `turn.steer` | 加入当前 turn steering queue | 否 |
| `turn.follow_up` | 加入后续 turn queue | 否 |
| `compact` | 调用 `compact_context()` | 控制路径 |
| `model.set` | 更新 runtime client 与 session metadata | 控制路径 |
| `session.switch` | idle 时切换 session 并返回 preview | 控制路径 |
| `goal.*` | 读取、设置、更新或清除 goal | 控制路径 |
| `slash.execute` | readonly 命令立即响应，其余复用 CLI router | 取决于命令 |

## 9. 失败和退出路径

- 参数解析失败：argparse 自己输出错误并退出；
- session id 非法：`main.py` 输出 `Session error`，返回 `1`；
- settings 无效：输出 `Configuration error`，返回 `1`；
- session 初始化/持久化失败：runtime 转换为 `PersistenceError`，产生失败事件；
- provider 非 context 错误：产生 `turn_failed`；
- context 超限：compact -> hard-limit rescue -> 仍失败才终止；
- cancellation：产生 `turn_cancelled`，清理 active turn 和 pending queues；
- CLI Ctrl+C：`ChatCLI` 清理运行时后返回 `130`；
- 正常退出：返回 `0`。

## 10. 从入口跟读代码的路径

```text
main.py
  -> agent/bootstrap/container.py
     -> agent/application/runtime/runtime.py
        -> agent/application/runtime/turn_runner.py
           -> agent/application/context/manager.py
           -> agent/application/runtime/stream_pump.py
           -> agent/application/tools/processor.py
              -> agent/application/tools/executor.py
                 -> agent/infrastructure/tools/builtin/*
           -> agent/infrastructure/persistence/jsonl_session_store.py

CLI output:
  agent/interfaces/cli/chat_cli.py
    -> agent/interfaces/cli/status/*
    -> agent/interfaces/cli/ui/*

stdio/API output:
  agent/interfaces/runtime_server/stdio.py
    -> agent/interfaces/runtime_server/protocol.py
  agent/interfaces/api/routes_session.py
    -> SSE envelope

Node terminal client:
  frontend-cli/bin/rind.js
    -> frontend-cli/lib/runtime-protocol.js
    -> frontend-cli/lib/*state.js / input modules
    -> frontend-cli/lib/rendering.js
```
