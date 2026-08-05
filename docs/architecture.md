# Rind 当前代码架构

> 本文以当前代码为准，描述单 Agent runtime、CLI/API 接口、工具执行、上下文管理、事件协议和 JSONL session 持久化。图中的“当前边界”反映实际代码，不代表未来重构目标。

## 1. 系统分层与依赖方向

```mermaid
flowchart TB
    Main["main.py\nCLI 参数与启动"]
    Bootstrap["agent/bootstrap/container.py\nbuild_agent_container\nAgentContainer"]

    subgraph Interfaces["agent/interfaces · 输入输出适配层"]
        CLI["cli/\nChatCLI"]
        Commands["cli/commands/\nrouter · features · status"]
        CLIUI["cli/ui/ + cli/status/\n输入、流式渲染、状态面板"]
        API["api/\nmain · dependencies · routes_session"]
        Stdio["runtime_server/\nstdio · protocol"]
    end

    subgraph Application["agent/application · 单 Agent 应用编排"]
        Runtime["runtime/\nAgentRuntime · TurnRunner"]
        Stream["stream_parser.py · stream_pump.py"]
        Context["context/\nContextManager · compaction · estimator"]
        ToolsApp["tools/\nToolCallProcessor · ToolExecutor"]
        SkillsApp["skill_selection.py\nSkillSelector"]
        Ports["ports/\nChatClient · SessionStore · ToolRegistry"]
    end

    subgraph Domain["agent/domain · 无外部实现依赖的模型"]
        Events["events.py\nRuntimeEvent 与 turn/tool/context 事件"]
        Models["cancellation · errors · goal · planning\nmessage_boundary · skills · tool_payload · tool_result"]
    end

    subgraph Infrastructure["agent/infrastructure · 外部实现"]
        Config["config/\nAppSettings · settings loader"]
        LLM["llm/\nOpenAIClientFactory · OpenAIChatClient"]
        Persist["persistence/\nJsonlSessionStore + repositories"]
        ToolInfra["tools/\nregistry · schema · builtin catalogs/tools"]
        SkillInfra["skills/\nSkillRepository"]
        Plan["planning/ + rind_docs.py\nplan context 与 RIND 文档"]
        Paths["paths.py\nsession/path validation"]
    end

    Frontend["frontend-cli/\nNode process client、协议解析、状态、终端渲染"]

    Main --> Bootstrap
    Bootstrap --> CLI
    Bootstrap --> Runtime
    Bootstrap --> Context
    Bootstrap --> ToolsApp
    Bootstrap --> LLM
    Bootstrap --> Persist
    Bootstrap --> ToolInfra

    CLI --> Runtime
    CLI --> Commands
    CLI --> CLIUI
    API --> Runtime
    Stdio --> Runtime
    Stdio --> Commands
    Frontend --> Stdio

    Runtime --> Context
    Runtime --> ToolsApp
    Runtime --> Stream
    Runtime --> Ports
    Context --> Ports
    ToolsApp --> Ports
    Application --> Domain
    Context --> SkillsApp

    LLM -. implements .-> Ports
    Persist -. implements .-> Ports
    ToolInfra -. implements .-> Ports
    SkillInfra --> Context
    Plan --> Context
    Config --> Bootstrap
    Paths --> Persist

    Interfaces -. current direct imports .-> Config
    Interfaces -. current direct imports .-> Paths
    Interfaces -. current direct imports .-> Persist
```

### 依赖规则

| 层 | 当前职责 | 允许依赖 | 不应承载 |
| --- | --- | --- | --- |
| `domain` | 事件、错误、边界模型、取消令牌 | Python 标准库 | provider、文件、终端、HTTP |
| `application` | turn、context、tool、skill 的应用编排 | `domain`、`ports` | 具体 OpenAI、JSONL、CLI 输出 |
| `infrastructure` | LLM、session、工具、配置、规划、文档的具体实现 | `domain`、`application.ports` | CLI/API 处理 |
| `interfaces` | CLI、API、stdio、协议和展示 | runtime/use case；当前仍有少量具体 infrastructure import | 核心 turn 策略、文件持久化细节 |
| `bootstrap` | 显式创建并连接依赖 | 所有实现层 | 运行时业务逻辑 |

当前架构测试已经阻止 application 反向依赖 infrastructure，也确保入口使用共享 `build_agent_container`。接口层的 concrete import 和 session 私有字段穿透仍是现状边界，见阶段重构计划。

## 2. Composition Root 与实际对象图

```mermaid
flowchart LR
    Settings["AppSettings\nload_settings()"]
    Factory["OpenAIClientFactory"]
    Store["JsonlSessionStore\nSessionStore port"]
    Registry["DefaultToolRegistry\nTOOL_SPECS"]
    Executor["ToolExecutor"]
    Normalizer["ToolResultNormalizer"]
    Processor["ToolCallProcessor"]
    Client["OpenAIChatClient\nChatClient port"]
    Parser["MessageStreamParser"]
    Estimator["ContextEstimator"]
    Skills["SkillRepository + SkillSelector"]
    Context["ContextManager"]
    Compact["CompactionService"]
    Runner["TurnRunner"]
    Runtime["AgentRuntime"]
    Container["AgentContainer\n同步保存上述组件"]

    Settings --> Factory --> Client
    Store --> Runtime
    Registry --> Executor --> Processor
    Normalizer --> Processor
    Processor --> Runner
    Client --> Runner
    Parser --> Runner
    Estimator --> Context
    Skills --> Context
    Context --> Runner
    Compact --> Runner
    Runner --> Runtime
    Container -. contains .-> Settings
    Container -. contains .-> Store
    Container -. contains .-> Registry
    Container -. contains .-> Executor
    Container -. contains .-> Processor
    Container -. contains .-> Client
    Container -. contains .-> Context
    Container -. contains .-> Compact
    Container -. contains .-> Runner
    Container -. contains .-> Runtime
```

`build_agent_container()` 的实际创建顺序是：settings/provider factory -> session store -> tool registry/executor/normalizer/processor -> LLM client -> stream parser -> context estimator/skill components/context manager -> compaction service -> turn runner -> runtime。

`AgentContainer` 是 dataclass facade，保存运行时需要的对象；`main.py` 只取 `container.runtime` 和 `container.session_store` 创建 `ChatCLI`。API、stdio 使用同一 composition root，不应自行复制这一组装流程。

### 能力注册边界

```mermaid
flowchart LR
    CompositionRoot["bootstrap/container.py\nAgentContainer"] --> ToolCatalog["build_builtin_tool_specs"]
    ToolCatalog --> ToolRegistry["DefaultToolRegistry"]
    ToolRegistry --> Runtime["AgentRuntime / TurnRunner"]
    Cli["ChatCLI"] --> CommandRouter["SlashCommandRouter"]
    Stdio["stdio JSONL"] --> CommandRouter
    CommandCatalog["commands/features/build_command_infos"] --> CommandRouter
    Stdio -->|initialize.slash_commands| Frontend["frontend-cli"]
```

- `agent/infrastructure/tools/builtin/__init__.py` 只按固定顺序组合各工具模块的 `TOOL_SPECS`；`AgentContainer` 在构造 registry 前筛选 `enabled_tools`。
- `agent/interfaces/cli/commands/features/` 是 slash command 的唯一内置 catalog。每个功能模块提供自己的 `SlashCommandInfo` 和 handler，router 负责校验名称、alias 和分发。
- `ChatCLI` 与 stdio 都从 router 读取注册结果；frontend-cli 只消费 `initialize.slash_commands` 生成菜单、帮助和补全，不维护另一份命令目录。

## 3. 一次 turn 的运行时结构

```mermaid
sequenceDiagram
    autonumber
    participant Input as ChatCLI / API / stdio
    participant Runtime as AgentRuntime
    participant Store as SessionStore
    participant Runner as TurnRunner
    participant Context as ContextManager
    participant LLM as ChatClient
    participant Pump as stream_pump + MessageStreamParser
    participant Processor as ToolCallProcessor
    participant Executor as ToolExecutor
    participant Tool as Builtin Tool
    participant Output as RuntimeEvent consumer

    Input->>Runtime: initialize() / run_turn(query)
    Runtime->>Store: initialize session
    Runtime->>Runner: run_turn(session, turn_id)
    Runner-->>Output: turn_started

    loop 直到无工具调用且 turn 完成
        Runner->>Context: resolve skills + build context
        Context->>Store: read messages / metadata
        Context-->>Runner: ContextBuildResult(messages, stats, decisions)
        Runner-->>Output: context_built / skill_activated

        alt 需要自动压缩或 context recovery
            Runner->>Context: compact / reduce hard limit / rescue
            Context->>Store: read and persist compaction boundary
            Context-->>Runner: rebuilt context
        end

        Runner->>LLM: stream(messages, tools)
        LLM-->>Pump: provider chunks
        Pump->>Runner: assistant_delta / tool_input_delta
        Runner-->>Output: incremental events

        alt 无工具调用
            Runner->>Store: persist assistant message
        else 有工具调用
            Runner->>Store: persist assistant tool-call message
            Runner-->>Output: tool_requested
            Runner->>Processor: process_tool_calls()
            Processor->>Executor: execute_tool(call)
            Executor->>Tool: invoke
            Tool-->>Executor: ToolResult
            Executor-->>Processor: normalized result
            Processor->>Store: persist tool_call + tool message
            Processor-->>Runner: tool_result / file_change / question event
            Runner-->>Output: tool events
        end
    end

    Runner->>Store: persist sampling usage and turn state
    Runner-->>Runtime: turn_completed / turn_failed / turn_cancelled
    Runtime-->>Input: terminal event stream
```

### Runtime 的状态与控制入口

`AgentRuntime` 维护 session-bound runtime 的运行状态：

- `_initialized` 与初始化锁：保证 session store 只初始化一次；
- `_turn_lock`：禁止并行 turn、session switch、goal replacement；
- `_active_turn_id`、`_accepting_inputs`：标记可接收 steering/follow-up 的窗口；
- steering queue 与 follow-up queue：分别在当前 turn 中改变方向、或当前 turn 结束后追加输入；
- goal continuation：turn 完成后读取 active goal，必要时继续执行；
- terminal event persistence：保存 turn state 和最终事件。

控制请求由 stdio/API 映射到 runtime：`turn.start`、`turn.interrupt`、`turn.steer`、`turn.follow_up`、`model.set`、`session.switch`、`compact`、`goal.*`。

## 4. 上下文与压缩结构

```mermaid
flowchart TB
    Store["SessionStore\nmessages · meta · usage · compaction"]
    Rind["build_rind_doc_context\nRIND.md / user docs"]
    Skills["SkillRepository\nSkillSelector"]
    Pending["transient system messages\nturn-scoped input"]
    Estimator["ContextEstimator\ntoken estimate"]
    Budget["ContextBudget\nmodel-aware limits"]
    Manager["ContextManager"]
    Result["ContextBuildResult\nmessages · stats · decisions"]
    Compact["CompactionService\nplan snapshot + handoff"]

    Store --> Manager
    Rind --> Manager
    Skills --> Manager
    Pending --> Manager
    Estimator --> Budget --> Manager
    Manager --> Result
    Manager --> Compact
    Compact --> Store
    Result --> Turn["TurnRunner"]
```

`ContextManager` 当前负责：读取持久消息、注入 RIND 文档和 skills、处理临时 system message、估算 token、判断 compact、执行 hard-limit rescue，并返回统计与决策。它不调用 LLM，也不执行工具。

`CompactionService` 通过 `build_plan_snapshot()` 获取计划摘要，生成 compact/handoff 结果；session store 负责实际持久化 compaction 记录和消息边界。

## 5. 工具调用结构

```mermaid
flowchart TB
    Schemas["DefaultToolRegistry\nTOOL_SPECS + JSON schemas"]
    Executor["ToolExecutor\n查找 + 参数调用 + async/sync bridge"]
    Processor["ToolCallProcessor\n逐个调用、心跳、轮询保护、持久化、事件"]
    Normalizer["ToolResultNormalizer\n统一 ToolResult"]
    Question["user_question responder\nask_user_question"]
    Change["change_events\n文件变化事件"]
    Shell["builtin/shell\nsession_pool · supervisor · process · capture · policy"]
    Files["builtin/files\noperations · mutations"]
    Goal["builtin/goal.py"]
    Planning["builtin/planning.py"]
    Skill["builtin/skill.py"]
    Web["builtin/web.py"]
    UserQ["builtin/user_question.py"]
    Store["SessionStore\ntool_calls + tool messages"]
    Events["RuntimeEvent\ntool_requested/started/result/file_changed/question"]

    Schemas --> Executor
    Executor --> Processor
    Processor --> Normalizer
    Processor --> Question
    Processor --> Change
    Processor --> Store
    Processor --> Events
    Executor --> Shell
    Executor --> Files
    Executor --> Goal
    Executor --> Planning
    Executor --> Skill
    Executor --> Web
    Executor --> UserQ
```

工具执行顺序是：解析 provider tool call -> registry 查找 -> executor 调用 -> 结果归一化 -> 必要时等待用户 -> 持久化工具调用和工具消息 -> 发出事件 -> 将结果追加回下一轮 context。

## 6. Session 持久化结构

```mermaid
flowchart LR
    Store["JsonlSessionStore\n生命周期协调 facade"]
    Files["SessionFiles\n路径与原子 JSON/JSONL I/O"]
    Messages["MessageRepository\nmessages.jsonl"]
    Tools["ToolCallRepository\ntool_calls.jsonl"]
    Compact["CompactionRepository\ncompactions.jsonl"]
    Index["SessionIndexRepository\nindex.json"]
    Meta["SessionMeta\nmeta.json: model, counts, goal, usage, turn state"]
    Projector["MessageProjector\nreplay / preview / projections"]
    Disk["session-dir/\n<session-id>/base.jsonl files"]

    Store --> Files
    Store --> Messages
    Store --> Tools
    Store --> Compact
    Store --> Index
    Store --> Meta
    Store --> Projector
    Files --> Disk
    Messages --> Disk
    Tools --> Disk
    Compact --> Disk
    Index --> Disk
    Meta --> Disk
```

Session store 同时提供 application `SessionStore` port 所需能力：initialize/discard/switch、message/tool persistence、recent sessions、resume preview、model metadata、sampling usage、turn state、goal 和 compaction。当前 `JsonlSessionStore` 是 facade，底层 repository 已按文件类型拆开。

## 7. Runtime 事件与传输

```mermaid
flowchart LR
    DomainEvents["agent/domain/events.py\n事件 dataclass + event_meta"]
    Runtime["TurnRunner / AgentRuntime\n产生事件"]
    Protocol["runtime_server/protocol.py\nevent_envelope\nsequence · durability · ids"]
    Stdio["runtime_server/stdio.py\nJSONL request/response/event"]
    SSE["api/routes_session.py\nSSE envelope"]
    JSProtocol["frontend-cli/lib/runtime-protocol.js\nrequest/event metadata"]
    JSState["frontend-cli/bin/rind.js\nturn/background/input state"]
    Render["frontend-cli/lib/rendering.js\nterminal text and menus"]
    CLIUI["agent/interfaces/cli/ui\nstreaming/status renderer"]

    DomainEvents --> Runtime
    Runtime --> Protocol
    Protocol --> Stdio
    Runtime --> SSE
    Stdio --> JSProtocol --> JSState --> Render
    Runtime --> CLIUI
```

事件分为 durable 和 incremental：assistant/tool input delta 属于增量事件，tool result、turn completed、turn failed 等需要持久化或恢复的状态属于 durable 事件。Python envelope 与 JS protocol 共同消费 `test/fixtures/runtime_protocol.golden.jsonl`。

## 8. frontend-cli（ts_cli 启动链）

仓库中没有独立的 `ts_cli` 目录；当前终端客户端实际位于 `frontend-cli/`，入口是 Node ESM 文件 `frontend-cli/bin/rind.js`。它不是直接调用 Python CLI，而是启动一个 Python stdio runtime 子进程，再通过 JSONL 控制协议驱动交互。

```mermaid
flowchart TB
    Command["rind / node frontend-cli/bin/rind.js"]
    Bin["bin/rind.js\n薄入口：调用 runFrontendCli()"]
    PublicEntry["lib/frontend-cli.js\n公开 runFrontendCli(cliArgs)"]
    App["frontend-cli-implementation.js\n应用编排与共享 state"]
    Fast["--help / --version\nspawnSync(python, main.py, stdio: inherit)"]
    RuntimeClient["runtime-client.js\nspawn Python + JSONL request/event"]
    Env["runtime-env.js\nPYTHONPATH + UTF-8 env"]
    Bootstrap["runtimeBootstrap Python -c\nrunpy.run_module(agent.interfaces.runtime_server.stdio)"]
    Child["Python StdioRuntimeServer\nstdin/stdout/stderr pipes"]
    ServerBoot["stdio.main / async_main\nsignal + args + Config + container"]
    Turn["turn-controller.js\nturn.start / follow_up / steer / interrupt"]
    Commands["command-controller.js\nslash command 分类与结果应用"]
    Input["input-controller.js\nTTY/non-TTY prompt、菜单、按键"]
    Events["event-controller.js\nassistant/tool/plan/goal/question events"]
    Background["background-controller.js\nbackground list + monitor"]
    Render["rendering.js + assistant-renderer.js\n终端文本与 Markdown 输出"]
    TTY["terminal-ui.js\n动态帧与光标控制"]
    Plain["readline fallback\n重定向/非 TTY 输入"]
    Shutdown["SIGINT / shutdown\ninterrupt -> shutdown -> close/kill"]

    Command --> Bin --> PublicEntry --> App
    App -->|help/version| Fast
    App --> RuntimeClient
    RuntimeClient --> Env --> Bootstrap --> Child --> ServerBoot --> Stdio
    RuntimeClient --> Events
    App --> Turn
    App --> Commands
    App --> Input
    App --> Background
    Input --> TTY
    Input --> Plain
    Commands --> Turn
    Turn --> RuntimeClient
    Background --> RuntimeClient
    Events --> Render
    Events --> Input
    Shutdown --> Turn
    Shutdown --> RuntimeClient
```

### frontend-cli 文件职责

| 文件 | 启动链中的职责 |
| --- | --- |
| `bin/rind.js` | 薄启动入口，只导入 `runFrontendCli()` 并传入 CLI 参数 |
| `lib/frontend-cli.js` | frontend-cli 公开入口，转发到实际应用编排 |
| `lib/frontend-cli-implementation.js` | 应用层装配：repoRoot、快速路径、initialize、controllers、共享 state、shutdown |
| `lib/runtime-client.js` | Python child process、stdout JSONL 分包、request pending、event 转发、shutdown/kill |
| `lib/turn-controller.js` | turn.start、turn.follow_up、turn.steer、interrupt 和 turn 生命周期状态 |
| `lib/command-controller.js` | 普通文本、slash command、本地交互命令、slash result 应用 |
| `lib/input-controller.js` | TTY/non-TTY prompt、line editor、菜单、暂停/恢复、用户问题输入 |
| `lib/event-controller.js` | assistant 流式输出、工具事件、plan/goal、user question、turn 结束状态 |
| `lib/background-controller.js` | background task 列表、结果合并、monitor 进入/退出与轮询 |
| `lib/runtime-env.js` | 为 Python child 构造 `PYTHONPATH`、UTF-8 和环境变量 |
| `lib/runtime-protocol.js` | 创建 request、读取 request id、识别 event type、选择 `turn.start`/`turn.follow_up` |
| `lib/terminal-ui.js` | TTY 动态帧、光标和外部输出暂停/恢复 |
| `lib/line-editor.js`、`terminal-key.js` | 非 TTY/TTY 输入编辑、按键解析、宽字符光标处理 |
| `lib/*-state.js` | compact、model、slash、choice、interrupt 等局部交互状态 |
| `lib/rendering.js`、`assistant-renderer.js` | startup、prompt、tool/status、markdown assistant 输出 |

启动后存在两条输入模式：TTY 通过 `input-controller` 调用 `createTerminalUI()`、line editor 和菜单状态；非 TTY 通过 Node `readline` 与 stdin data listener。两条路径共享 `turn-controller`、`command-controller`、`runtime-client`、runtime event 分发和最终 shutdown。

## 9. 当前目录结构

```text
.
├── main.py
├── agent/
│   ├── bootstrap/
│   │   └── container.py                 # AgentContainer 与唯一生产组装入口
│   ├── domain/
│   │   ├── events.py                    # runtime/tool/context/turn 事件
│   │   ├── cancellation.py              # CancellationToken
│   │   ├── errors.py                    # 领域与 provider/persistence 错误
│   │   ├── message_boundary.py          # model/compact 消息边界校验
│   │   ├── compaction.py goal.py planning.py skills.py
│   │   └── tool_payload.py tool_result.py
│   ├── application/
│   │   ├── runtime/
│   │   │   ├── runtime.py               # AgentRuntime facade、输入队列、控制操作
│   │   │   ├── turn_runner.py            # 单 turn 主循环
│   │   │   ├── stream_parser.py          # provider stream 解析
│   │   │   └── stream_pump.py            # stream -> RuntimeEvent
│   │   ├── context/
│   │   │   ├── manager.py                # context 组装、预算与 rescue
│   │   │   ├── compaction.py             # compact service
│   │   │   ├── estimator.py token_usage.py handoff.py
│   │   ├── tools/
│   │   │   ├── processor.py              # 工具调用循环与结果持久化
│   │   │   ├── executor.py               # registry lookup 与工具调用
│   │   │   ├── result_normalizer.py
│   │   │   ├── change_events.py polling_guard.py
│   │   ├── ports/                         # ChatClient/SessionStore/ToolRegistry
│   │   └── skill_selection.py
│   ├── infrastructure/
│   │   ├── config/ llm/ paths.py
│   │   ├── persistence/                   # JsonlSessionStore 与 repositories
│   │   ├── tools/                         # registry/schema/builtin tools
│   │   ├── skills/                        # SkillRepository
│   │   ├── planning/ rind_docs.py         # plan 与 RIND 文档
│   ├── interfaces/
│   │   ├── cli/                           # ChatCLI、commands、ui、status
│   │   ├── api/                           # FastAPI 应用与 session route
│   │   └── runtime_server/                # stdio server 与 versioned protocol
│   └── prompts.py                         # SYSTEM_PROMPT 与 goal prompt
├── frontend-cli/
│   ├── bin/rind.js                        # 薄 Node 启动入口
│   ├── lib/                               # runtime client、controllers、protocol、输入、状态、渲染模块
│   └── test/
├── sessions/                              # 运行时 session artifact
└── test/                                  # Python 单元、协议和集成测试
```

## 10. 关键边界与阅读顺序

要理解整个项目，建议按以下顺序阅读：

1. `main.py`：确认启动参数、配置校验和 `build_agent_container()`。
2. `agent/bootstrap/container.py`：确认所有生产对象如何连接。
3. `agent/application/runtime/runtime.py`：理解 turn lock、输入队列、goal 和 session control。
4. `agent/application/runtime/turn_runner.py`：理解 context -> model -> tool -> continuation 主循环。
5. `agent/application/context/manager.py` 与 `context/compaction.py`：理解 token budget、skills、RIND docs 和 compact。
6. `agent/application/tools/processor.py` 与 `tools/executor.py`：理解工具结果、问答、文件变化和持久化。
7. `agent/infrastructure/persistence/jsonl_session_store.py`：理解 session 文件与 repositories。
8. `agent/interfaces/runtime_server/stdio.py`、`api/routes_session.py`、`cli/chat_cli.py`：理解三种输出和控制入口。
9. `frontend-cli/bin/rind.js`、`lib/frontend-cli-implementation.js`、`lib/runtime-client.js`、`lib/*-controller.js`：理解 Node CLI 如何启动 Python runtime、路由输入并消费事件。
