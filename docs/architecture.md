# Agent 整体架构

## 系统层级架构图

```mermaid
graph TB
    A["main.py (CLI & API 入口)"]
    B["bootstrap/container.py (依赖注入容器)"]
    C["interfaces/cli/ (命令行界面)"]
    D["interfaces/api/ (REST API 接口)"]
    E["runtime/ (运行时编排)"]
    F["services/ (领域服务)"]
    G["ports/ (端口/接口)"]
    H["events.py (领域事件)"]
    I["tool_payload.py (工具载荷)"]
    J["config/ (配置管理)"]
    K["llm/ (LLM 客户端)"]
    L["persistence/ (持久化)"]
    M["tools/ (工具实现)"]

    A --> B
    B --> C
    B --> D
    B --> E
    B --> F
    B --> G
    C --> E
    D --> E
    E --> F
    E --> M
    F --> G
    G --> H
    G --> K
    G --> L
    E --> K
    F --> L
```

## 数据流架构图 (会话流程)

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户
    participant CLI as CLI/API
    participant Runtime as 运行时
    participant ContextManager as 上下文管理器
    participant SessionStore as 会话存储
    participant Compaction as 压缩服务
    participant LLM as LLM 客户端
    participant ToolProcessor as 工具处理器
    participant Tools as 具体工具

    User->>CLI: 输入消息
    CLI->>Runtime: 执行回合
    activate Runtime

    loop 回合主循环
        Runtime->>ContextManager: 构建上下文
        activate ContextManager
        ContextManager->>SessionStore: 加载历史消息
        SessionStore-->>ContextManager: 返回消息列表
        ContextManager-->>Runtime: 返回上下文消息
        deactivate ContextManager

        Runtime->>LLM: 发送 Prompt
        activate LLM
        LLM-->>Runtime: 返回流式响应
        deactivate LLM

        Runtime->>ToolProcessor: 执行工具
        activate ToolProcessor
        ToolProcessor->>Tools: 调用具体工具
        activate Tools
        Tools-->>ToolProcessor: 返回结果
        deactivate Tools
        ToolProcessor->>SessionStore: 持久化工具结果
        SessionStore-->>ToolProcessor: 保存完成
        ToolProcessor-->>Runtime: 工具执行完成
        deactivate ToolProcessor

        Runtime->>SessionStore: 持久化消息
        SessionStore-->>Runtime: 保存完成
    end

    deactivate Runtime
    Runtime-->>CLI: 返回完整响应
    CLI-->>User: 显示最终响应
```

## 核心组件交互图

```mermaid
graph LR
    A[用户] --> B[Chat CLI]
    B --> C[AsyncRuntimeFacade]
    C --> D[AsyncTurnRunner]
    D --> E[ContextManager]
    D --> F[AsyncChatClient]
    F --> G[OpenAIAsyncClient]
    D --> H[MessageStreamParser]
    D --> I[AsyncToolCallProcessor]
    I --> J[ToolExecutor]
    J --> K[Bash Tool]
    J --> L[File Ops Tool]
    J --> M[Web Tool]
    J --> N[Skill Tool]
    D --> O[AsyncJsonlSessionStore]
```

## 超详细数据流图 (代码级)

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant CLI as ChatCLI
    participant Renderer as StreamingRenderer
    participant StatusRenderer as StatusRenderer
    participant TurnRunner as AsyncTurnRunner
    participant ContextManager as ContextManager
    participant SessionStore as AsyncJsonlSessionStore
    participant ChatClient as AsyncChatClient
    participant ToolProcessor as AsyncToolCallProcessor
    participant ToolExecutor as ToolExecutor
    participant Tool as 具体工具实现

    User->>CLI: 用户输入
    CLI->>TurnRunner: run_turn()
    activate TurnRunner
    TurnRunner-->>CLI: TurnStartedEvent
    CLI->>StatusRenderer: handle(event)

    TurnRunner->>ContextManager: build_context()
    activate ContextManager
    ContextManager->>SessionStore: list_messages()
    SessionStore-->>ContextManager: List[Message]
    ContextManager->>ContextManager: 组装 system+user 消息
    ContextManager-->>TurnRunner: 返回完整上下文
    deactivate ContextManager
    TurnRunner-->>CLI: ContextBuiltEvent
    CLI->>StatusRenderer: handle(event)

    TurnRunner->>ChatClient: stream_chat(messages)
    activate ChatClient
    loop 流式接收
        ChatClient-->>TurnRunner: StreamingChunk
        TurnRunner->>TurnRunner: parse_stream()
        TurnRunner->>TurnRunner: 累积 response delta
        TurnRunner-->>CLI: AssistantDeltaEvent
        CLI->>Renderer: append(text)
        Renderer-->>CLI: 更新屏幕显示
    end
    deactivate ChatClient
    TurnRunner-->>CLI: AssistantMessageCompletedEvent
    CLI->>Renderer: finish_message()

    alt 有工具调用
        TurnRunner->>SessionStore: persist_message(assistant)
        activate SessionStore
        SessionStore->>SessionStore: _append_jsonl_line()
        deactivate SessionStore

        TurnRunner-->>CLI: ToolRequestedEvent
        CLI->>StatusRenderer: handle(event)

        TurnRunner->>ToolProcessor: process_tool_calls()
        activate ToolProcessor

        loop 逐个执行工具
            TurnRunner-->>CLI: ToolCallStartedEvent
            CLI->>StatusRenderer: handle(event)

            ToolProcessor->>ToolExecutor: execute_tool()
            activate ToolExecutor
            ToolExecutor->>Tool: 调用工具函数
            activate Tool
            Tool-->>ToolExecutor: 返回结果
            deactivate Tool
            ToolExecutor-->>ToolProcessor: 返回解析后的结果
            deactivate ToolExecutor

            Note over ToolProcessor, SessionStore: 关键：先持久化工具调用
            ToolProcessor->>SessionStore: persist_tool_call(tool_call)
            activate SessionStore
            SessionStore->>SessionStore: _append_jsonl_line()
            deactivate SessionStore

            ToolProcessor->>SessionStore: persist_message(tool)
            activate SessionStore
            SessionStore->>SessionStore: _append_jsonl_line()
            deactivate SessionStore

            Note over ToolProcessor, TurnRunner: 持久化完成后才通知
            ToolProcessor-->>TurnRunner: yield ToolResultEvent
            TurnRunner-->>CLI: ToolResultEvent
            CLI->>StatusRenderer: handle(event)
        end

        deactivate ToolProcessor
    else 无工具调用
        TurnRunner->>SessionStore: persist_message(assistant)
        activate SessionStore
        SessionStore->>SessionStore: _append_jsonl_line()
        deactivate SessionStore
    end

    TurnRunner-->>CLI: TokenStatsUpdatedEvent
    CLI->>StatusRenderer: handle(event)

    deactivate TurnRunner
    TurnRunner-->>CLI: TurnCompletedEvent
    CLI->>StatusRenderer: handle(event)
    CLI-->>User: 展示完整输出
```

## 目录结构说明

### 整体架构分层
```
├── agent/
│   ├── interfaces/        # 接口层：CLI 和 API 入口
│   ├── application/       # 应用层：业务逻辑和编排
│   ├── domain/            # 领域层：核心模型和事件
│   ├── infrastructure/    # 基础设施层：外部依赖实现
│   ├── bootstrap/         # 引导层：依赖注入容器
│   └── prompts.py         # 系统提示词
├── main.py                # 程序入口
```

### 各层详细职责

1. **接口层 (Interfaces)**
   - CLI：命令行交互、流式渲染、富文本 UI
   - API：RESTful 服务端点

2. **应用层 (Application)**
   - Runtime：回合调度、工具处理流程
   - Services：压缩、上下文管理、Token 用量
   - Ports：接口契约抽象

3. **领域层 (Domain)**
   - 事件定义、工具载荷、压缩边界模型

4. **基础设施层 (Infrastructure)**
   - LLM 客户端、JSONL 持久化、工具实现、技能仓库、规划系统
