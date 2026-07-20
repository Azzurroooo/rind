# Main.py 完整数据流图

## 完整启动流程 Mermaid 图

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户
    participant Main as main.py
    participant Args as argparse (参数解析)
    participant Doctor as Doctor (诊断)
    participant Config as Config (配置)
    participant Container as build_basic_agent_dependencies
    participant CLI as ChatCLI

    User->>Main: python main.py [参数]

    Note over Main: 第 1 阶段：参数解析 (line 9-17)
    Main->>Args: argparse.ArgumentParser()
    Args-->>Main: args 对象

    Note over Main: 第 2 阶段：检查 Doctor 模式 (line 19-29)
    alt --doctor 参数存在
        Main->>Doctor: build_doctor_report()
        Doctor-->>Main: 诊断报告
        Main->>User: 打印诊断报告
        Main->>User: 退出程序
    else 正常模式继续
    end

    Note over Main: 第 3 阶段：验证 Session ID (line 31-38)
    alt --session 参数存在
        Main->>Main: validate_session_id()
        alt 验证失败
            Main->>User: 打印 Session error
            Main->>User: 返回 1 (退出)
        else 验证成功
        end
    end

    Note over Main: 第 4 阶段：初始化配置 (line 44-49)
    Main->>Config: ensure_user_settings_template()
    Config->>Config: 检查 settings.json 是否存在
    Config-->>Main: 路径（可能创建了默认模版）

    Main->>Config: reload()
    Config->>Config: 从 settings.json 加载配置

    Main->>Config: validate()
    alt 验证失败
        Main->>User: 打印 Configuration error
        Main->>User: 返回 1 (退出)
    else 验证成功
    end

    Note over Main: 第 5 阶段：处理环境变量 (line 51-52)
    alt --allow-unsafe-bash
        Main->>Main: 设置 AGENT_ALLOW_UNSAFE_BASH=1
    end

    Note over Main: 第 6 阶段：构建依赖容器 (line 54-59)
    Main->>Container: build_basic_agent_dependencies()

    Note over Container: 初始化基础设施 (line 33-57)
    Container->>Container: AsyncJsonlSessionStore
    Container->>Container: DefaultToolRegistry
    Container->>Container: ToolExecutor
    Container->>Container: AsyncOpenAIChatClient (注入 reasoning_effort)
    Container->>Container: PlanContextProvider
    Container->>Container: SkillRepository
    Container->>Container: SkillSelector
    Container->>Container: AsyncToolCallProcessor
    Container->>Container: MessageStreamParser

    Note over Container: 初始化应用层 (line 58-81)
    Container->>Container: ContextManager (包含 ContextBudget)
    Container->>Container: AsyncTurnRunner
    Container->>Container: AsyncRuntimeFacade

    Note over Container: 初始化接口层 (line 83)
    Container->>Container: ChatCLI

    Container-->>Main: 返回依赖字典 { "cli": ChatCLI, ... }

    Note over Main: 第 7 阶段：启动 CLI (line 60)
    Main->>CLI: cli.start()

    Note over CLI: 进入交互式模式
    loop 主聊天循环
        CLI->>User: 等待用户输入
        User->>CLI: 输入消息

        CLI->>CLI: 执行完整回合

        CLI->>User: 实时展示
    end

    alt 用户按 Ctrl+C
        CLI->>User: 打印 "Interrupted."
        CLI->>User: 返回 130
    else 正常结束
        CLI->>User: 返回 0
    end
```

## 各阶段详细说明

### 1. 参数解析（Line 9-17）
解析所有命令行参数：
- `--version` - 显示版本号
- `--debug` - 调试模式
- `--allow-unsafe-bash` - 允许危险的 shell 命令
- `--session` - 指定 Session ID
- `-c, --resume-latest` - 恢复最近的会话
- `--session-dir` - 会话存储目录
- `--doctor` - 运行诊断

### 2. Doctor 模式（Line 19-29）
如果使用 `--doctor`：
- 构建诊断报告
- 打印报告
- 退出程序

### 3. Session ID 验证（Line 31-38）
验证 Session ID 格式是否合法

### 4. 配置初始化（Line 44-49）
```python
Config.ensure_user_settings_template()  # 确保 settings.json 存在
Config.reload()                          # 重新加载配置
Config.validate()                        # 验证配置
```

### 5. 环境变量设置（Line 51-52）
如果使用 `--allow-unsafe-bash`，设置 `AGENT_ALLOW_UNSAFE_BASH=1`

### 6. 依赖容器构建（Line 54-59）
调用 `build_basic_agent_dependencies()`，按以下顺序初始化：

1. **基础设施层**：
   - AsyncJsonlSessionStore（会话持久化）
   - DefaultToolRegistry（工具注册表）
   - ToolExecutor（工具执行器）
   - AsyncOpenAIChatClient（LLM 客户端）
   - PlanContextProvider（计划上下文）
   - SkillRepository（技能仓库）
   - SkillSelector（技能选择器）
   - AsyncToolCallProcessor（工具处理器）
   - MessageStreamParser（消息流解析器）

2. **应用层**：
   - ContextManager（上下文管理器）
   - AsyncTurnRunner（回合执行器）
   - AsyncRuntimeFacade（外观层）

3. **接口层**：
   - ChatCLI（命令行界面）

### 7. CLI 启动（Line 60）
调用 `cli.start()`，进入交互式聊天模式

## 异常处理

### KeyboardInterrupt（Ctrl+C）
```python
except KeyboardInterrupt:
    print("\nInterrupted.", file=sys.stderr)
    return 130
```
- 捕获中断
- 打印退出信息
- 返回状态码 130（标准中断码）

### 配置错误
```python
except ValueError as exc:
    print(f"Configuration error: {exc}", file=sys.stderr)
    return 1
```
- 捕获配置异常
- 打印错误信息
- 返回状态码 1

## 退出码

| 状态码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 配置错误 / Session 错误 / 诊断失败 |
| 130 | 用户中断（Ctrl+C） |
