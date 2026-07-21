# Rind 全面升级大纲

> 参考 Pi、OpenCode、Claude Code 与 Codex，在不扩大核心复杂度的前提下，提高 Rind 的可用性、可靠性、执行效率和 agent 能力。

- 文档状态：升级总纲
- 基线日期：2026-07-21
- 适用范围：Python 运行时、Node CLI、工具系统、会话持久化、上下文管理、资源加载、配置、Windows 分发和测试体系
- 核心约束：严格遵守根目录 `AGENTS.md`，优先高内聚、低耦合、显式副作用、准确命名、小函数和最小可行实现

## 1. 文档目的

本大纲不是把 Pi、OpenCode、Claude Code 或 Codex 的功能逐项复制到 Rind，而是回答四个问题：

1. 哪些成熟经验能直接改善 Rind 的正确性、速度、安全性和易用性。
2. 哪些能力应当缩小后实现，避免引入大型框架和长期维护负担。
3. 哪些能力与当前 Python 异步运行时、JSONL 会话和 stdio 前端协议不匹配，应明确不做。
4. 如何分阶段实施，使每一阶段都能独立交付、验证和回滚。

最终目标是让 Rind 成为一个可靠、直接、可恢复的本地 coding agent：核心链路短，用户能力完整，运行状态透明，失败可以恢复，扩展点少而稳定。

“全面升级”在本文中表示覆盖完整用户旅程，不表示建设完整平台。衡量升级效果的核心指标是能力密度：用尽可能少的核心概念、依赖和工具往返，完成尽可能完整、舒服的真实编码任务。

## 2. 参考范围与证据边界

### 2.1 参考快照

| 项目 | 参考快照 | 重点参考内容 |
| --- | --- | --- |
| Pi | 本地 `E:/code/agent1/pi`，`c8c3cd49` | 短 agent loop、steering/follow-up 队列、JSONL 会话、资源加载、多运行模式、Provider 边界 |
| OpenCode | [`a19b52e`](https://github.com/anomalyco/opencode/tree/a19b52e85bf2630b86157030e2cf7c9fc20ce552) | Agent 权限配置、会话压缩、工具注册、输出截断、项目实例、配置分层 |
| Codex | [`2deed3f`](https://github.com/openai/codex/tree/2deed3fb9c00c74dac3d177ea700d6fb7a94539d) | 稳定事件协议、审批与执行策略、上下文压缩、shell 生命周期、技能加载、TUI 状态管理 |
| Claude Code | [`015170d`](https://github.com/anthropics/claude-code/tree/015170d3fd84fb57ef4685a64b673fadd0690dc1) | 官方插件、Hook 示例、配置样例、变更记录与公开工作流 |

### 2.2 Claude Code 的特殊说明

Claude Code 的公开仓库包含 README、插件、Hook、配置样例和详细变更记录，但没有完整公开生产 CLI 的全部核心实现。因此：

- 可从公开代码中借鉴插件结构、Hook 契约、安全规则和工作流组织方式。
- 可从官方文档与变更记录中总结权限、checkpoint、MCP、上下文、后台任务和终端体验。
- 不把无法直接检查的内部实现描述成源码事实。
- 不复制其插件规模、企业管理能力或多代理产品形态。

### 2.3 借鉴原则

- 借鉴行为边界、状态模型、协议设计和失败处理，不复制大型目录结构。
- Pi 是轻量化理念上最接近 Rind 的参考对象，但只借鉴其高频行为和清楚边界，不复制庞大的 Extension API、Package Manager 或 Provider 目录规模。
- 优先复用 Python 标准库、现有依赖和 `rg`、Git 等可靠外部工具。
- 新增运行时依赖前必须证明标准库或现有依赖无法满足需求。
- 一个新抽象至少要解决一个当前存在的问题；不为假设中的未来功能预建框架。
- 新能力必须有默认关闭、按需加载或天然低成本的形态，不能持续消耗上下文、CPU 或内存。
- 一个工作项原则上只新增一个跨模块概念，并应同时删除、合并或简化已有逻辑。
- 所有队列、输出、并发、重试、后台进程、缓存和日志必须有小型明确上限。
- 如果现有 CLI 工具加一份 Skill 或 Prompt Template 已能低成本解决问题，就不新增核心协议。

### 2.4 功能进入门槛

候选能力进入 P0-P2 前必须同时满足：

1. 解决可复现的真实问题，而不是只满足竞品对标。
2. 明显缩短任务链路，或提高成功率、安全性和可恢复性。
3. 可以通过小型、明确、可测试的实现完成。
4. 未启用时接近零运行时、启动和上下文开销。
5. 有失败路径、资源上限、兼容策略和删除条件。

需要先建设平台才能产生价值的功能，默认放入 P3 候选区。

## 3. 产品与工程北极星

### 3.1 核心运行链路

核心循环应长期保持为：

```text
接收用户输入
  -> 构建有界上下文
  -> 调用模型并流式解析
  -> 审批与执行工具
  -> 持久化事实事件
  -> 继续采样或完成回合
```

任何升级如果要求在这条链路中增加多个隐式状态机、全局注册表或不可观察的后台副作用，应重新缩小设计。

### 3.2 六项不可牺牲的能力

1. 完整性：文件、shell、搜索、计划、技能、会话恢复和上下文压缩可用于真实编码任务。
2. 易用性：默认配置可运行，错误信息可操作，CLI 不闪烁、不破坏输入、不淹没终端。
3. 可恢复性：中断、崩溃、网络错误和上下文溢出不应破坏会话与已完成工作。
4. 安全性：工具执行前有明确边界，危险操作不能依赖模型自觉。
5. 简洁性：同一规则只有一个实现，同一状态只有一个权威来源，同一协议只有一个定义。
6. 可控性：agent 工作时用户仍可输入、纠正方向、排队后续工作、取回输入或取消。

### 3.3 明确非目标

- 不进行 Rust 重写。
- 不复制 OpenCode 的完整客户端/服务端平台架构。
- 不复制 Pi 的完整扩展 API、包管理器、主题系统或多 Provider catalog。
- 不构建 Claude Code 规模的插件市场、企业策略中心或远程控制平台。
- 不默认启用多代理、工作树编排或后台自治任务。
- 不在缺少基准证据时引入向量数据库、常驻代码索引器或 RAG 服务。
- 不把模型生成的自由文本摘要保存为长期事实或自动写入 `RIND.md`。
- 不自行实现复杂的操作系统沙箱；优先使用受支持的系统能力或外部隔离环境。
- 不长期维护两套拥有相同业务逻辑的交互式 CLI。
- 不把 MCP、Hook、subagent、LSP、sandbox 或图片输入作为“全面升级”的必选项。

## 4. 当前基线与主要差距

### 4.1 已有优势

Rind 已具备后续演进所需的主要骨架：

- Python 异步 turn runtime 和流式事件。
- application、domain、infrastructure、interfaces 分层。
- 结构化 `tool_ok` / `tool_error` 结果。
- append-only JSONL 会话、工具调用和 compaction 记录。
- 自动与手动上下文压缩、上下文超长恢复。
- shell 前后台任务、文件工具、Web、PDF、plan 和 skill。
- stdio runtime server 与 Node CLI。
- Node CLI 已允许工作期间继续输入并顺序排队完整 turn。
- Python CLI、API adapter、Windows EXE 和安装器。
- 覆盖 runtime、persistence、CLI、工具和上下文的测试体系。

这些能力说明升级应以收敛和强化为主，而不是重新搭建 agent framework。

### 4.2 当前需要优先处理的结构信号

以下是本次基线检查发现的高价值收敛点：

| 信号 | 当前表现 | 升级方向 |
| --- | --- | --- |
| 文件体积 | 多个 Python 文件超过 400 行；两个测试文件超过 800 行；Node 入口和 rendering 文件超过 900 行 | 按真实职责拆分，禁止为了拆分而增加空壳层 |
| 双 CLI | Python `ChatCLI` 与 Node CLI 均包含交互、状态和渲染逻辑 | 业务状态统一在 runtime/protocol；前端只保留展示与输入职责 |
| 配置状态 | `Config` 使用可变 class attributes，设置加载与 OpenAI client 构造绑定 | 改为不可变配置快照和显式 provider factory |
| 工具描述 | handler、schema、执行模式和输出策略分散 | 一个 `ToolSpec` 作为工具唯一描述 |
| 权限模型 | 主要依赖 shell 危险模式检测与全局 unsafe 开关 | 建立通用 `allow / ask / deny` 纯函数策略 |
| 环境变量 | 仍存在 `AGENT_ALLOW_UNSAFE_BASH`、`AGENT_SESSION_ROOT`、`AGENT_SESSION_ID` | 统一为 `RIND_*`，移除内部旧前缀 |
| 会话访问 | 某些运行时操作需要读取完整 message slice | 提供增量读取和索引，避免长会话重复扫描 |
| 运行中输入 | Node CLI 只能排队完整后续 turn，不能在下一次采样前纠正当前方向 | 增加小型 steering/follow-up 队列，语义归 runtime 所有 |
| 流式队列 | model stream 使用无界 `asyncio.Queue` | 使用小型有界合并队列，持久事实与终态不可丢失 |
| 防御式调用 | 跨层使用较多 `getattr`、`callable` 和宽泛异常吞掉 | 在端口边界明确能力，best-effort 行为必须可观测 |
| 编辑恢复 | 有文件变更事件，但缺少可靠的 turn checkpoint 与 `/undo` | 只记录本回合触及文件，提供冲突检测后的有限回滚 |
| 扩展能力 | Skill 已有，Prompt Template、MCP 和 Hook 尚未统一 | 先统一小型资源加载；Hook/MCP 仅在真实用例出现后实现 |
| 项目资源 | `RIND.md` 和 Skill 有清楚路径，但缺少统一来源诊断与 trust | 只统一 Context、Skill、Prompt Template 和设置，不建设 Package Manager |

### 4.3 与现有 `.docs` 的关系

本大纲吸收并统一现有的异步运行时、context compaction、工具清理、CLI 稳定性、Windows 打包和健壮性计划。后续实施时：

- 本文负责优先级、依赖顺序和总体边界。
- 已有专项文档继续提供具体问题背景与测试细节。
- 已完成或已失效的专项计划不应重复执行。
- 新增专项计划必须引用本文中的工作项 ID，避免出现相互冲突的路线图。

## 5. 四方经验对比与本地化结论

### 5.1 Pi 的轻量化启发

Pi 与 Rind 的产品目标最接近。最值得借鉴的不是“少做功能”，而是把高频体验放进短核心，把低频能力留给资源或外部工具：

- agent loop 长期保持为 model、tool、result、continue 四个主要步骤。
- steering 在当前工具批次后进入下一次采样，follow-up 在 agent 自然完成后开始。
- interactive、print/JSON、RPC 和 SDK 共用一个 session runtime。
- JSONL 会话完整保留历史，compaction 只改变活动上下文。
- 项目资源在 trust 之后加载，非交互模式不等待用户输入。
- Provider 通过统一消息边界接入，但 SDK 按需加载。

Rind 应采用这些行为边界，但不照搬 Pi 的大型 Extension API、Package Manager、主题系统、完整树形 TUI 或 Provider catalog。

### 5.2 横向对比

| 领域 | OpenCode | Claude Code | Codex | Rind 的取舍 |
| --- | --- | --- | --- | --- |
| 核心架构 | TypeScript 服务、项目实例、事件与多界面 | 产品核心未完整公开；公开材料强调工作流与扩展 | Rust core、协议 crate、TUI、exec、app server 分离 | 保留 Python core + stdio 协议，不复制多服务平台 |
| 工具注册 | 工具 schema、实现、权限和截断规则较系统化 | 插件可声明命令、agent、skill、Hook、MCP | 工具、审批、sandbox 和协议事件分层明确 | 用一个小型 `ToolSpec` 收敛元数据，不建依赖注入框架 |
| 权限 | 规则合并，按工具和路径 `allow/ask/deny` | 细粒度规则、模式、Hook 与 sandbox 配合 | 审批事件、exec policy amendment、网络策略 | 先做纯函数策略与会话级批准缓存，sandbox 作为可选 adapter |
| 上下文 | compaction、最近回合保护、工具输出裁剪 | `/context`、prompt cache、checkpoint、项目指令 | 手动/自动压缩、边界注入、compaction 事件 | 保留现有 compaction，强化边界、来源、可视化与增量读取 |
| 会话 | 项目实例、状态、revert、存储迁移 | resume、fork、rewind、后台会话 | rollout、resume、archive、turn metadata | 先完成 repair、增量读取和复制式 fork；树形 UI 与 undo 后置 |
| shell | 工具统一、截断与后台任务 | 权限解析、进程树清理、PowerShell 大量兼容修复 | shell snapshot、sandbox、审批、跨平台命令解析 | 建立单一 ProcessSupervisor；不复制完整 shell snapshot |
| CLI | 多种 TUI/serve/run 入口 | 成熟交互、状态行、后台任务、无障碍 | 稳定事件驱动 TUI、diff、resume picker | 保持安静、确定性渲染；新增高价值命令，不扩张面板系统 |
| 扩展 | plugin、MCP、agent、tool | command、skill、agent、Hook、MCP、plugin | skill、MCP、app/plugin、hooks | Skill + Prompt Template 优先；Hook/MCP 按真实用例二选一，暂不建 marketplace |
| 多代理 | primary/subagent 与并行任务 | subagent、team、worktree、workflow | collaboration agent 能力 | 默认不做；只在单代理稳定后提供受限、显式委派 |
| 可观测性 | 日志、事件、状态 | `/doctor`、状态、成本与 OTEL | trace、turn timing、protocol events | 默认本地结构化日志；OTEL 作为可选依赖 |

## 6. 目标架构

### 6.1 分层边界

```text
Interactive CLI / Headless CLI / API
                |
        versioned JSONL events
                |
          Runtime Facade
                |
      Input Queue + Agent Loop
                |
  Context -> Model -> Tool Loop -> Persistence
                |
 Provider | Tool Catalog | Permission | Session | Resources
                |
      local bounded adapters
```

### 6.2 权威状态来源

| 状态 | 唯一权威来源 |
| --- | --- |
| 会话消息与工具事实 | append-only session records |
| 当前 turn 与输入队列 | runtime 内存状态 + emitted events |
| 用户设置 | 一次加载得到的不可变 `AppSettings` |
| 工具能力 | `ToolSpec` catalog |
| 权限决策 | `PermissionPolicy` + 当前会话批准记录 |
| 项目指导 | 当前工作目录的 `RIND.md` |
| 用户指导 | `RIND_HOME/RIND.md` |
| 长任务控制状态 | plan store；不使用自由文本事实摘要 |
| CLI 展示状态 | 从 runtime events 投影，不反向成为业务状态 |

### 6.3 新实体数量控制

建议只引入以下跨模块实体：

- `RuntimeDependencies`：替代 composition root 返回的匿名字典。
- `ToolSpec`：统一 handler、schema、side-effect class、permission key 和 output policy。
- `PermissionDecision`：`allow`、`ask`、`deny` 加原因与可选建议规则。
- `QueuedInput`：区分 steering 与 follow-up，记录顺序、来源和是否已投递。

现有 session schema 应直接演进，不平行新增另一套会话实体。其余局部数据优先使用局部变量、现有 dataclass 或小型字典，不创建通用 manager、service locator 或事件总线。

## 7. 升级工作流 A：代码逻辑精简与边界收敛

### A0.1 拆分超长模块

- 优先级：P0
- 目标：满足 `AGENTS.md` 的 Python 文件目标和硬上限，同时降低变更冲突。
- 首批对象：
  - `bash_runner.py`
  - `file_ops.py`
  - `async_jsonl_session_store.py`
  - `chat_cli.py`
  - `context_manager.py`
  - `async_tool_call_processor.py`
  - 超过 800 行的 Python 测试文件
- 拆分原则：按进程生命周期、文件读写、记录投影、输入处理等真实职责拆分。
- 禁止事项：只为降低行数增加转发类、空 repository 或一行 wrapper。
- 验收：生产 Python 文件目标不超过 400 行，任何 Python 文件不得超过 800 行；公开行为和测试结果不变。

### A0.2 建立唯一工具描述 `ToolSpec`

- 优先级：P0
- 借鉴：OpenCode tool registry、Codex tool/protocol 分层。
- 当前问题：工具 handler、JSON schema、同步/异步判断、文件变更识别和输出处理分散。
- 最小实现：
  - 启动时构建不可变 tool catalog。
  - 每个 `ToolSpec` 只包含必要字段：名称、handler、schema、effect、permission key、output limit。
  - 在注册时预计算参数过滤和 coroutine 状态，移除每次调用的 `inspect.signature`。
  - 文件变更信息由工具结果直接返回，不在 processor 中根据工具名重建。
- 验收：新增工具只修改一个注册位置；未知工具、参数错误和执行错误仍统一输出 `tool_error`。

### A0.3 显式 composition root

- 优先级：P0
- 当前问题：`build_basic_agent_dependencies()` 返回 `dict[str, object]`，调用方依赖字符串 key。
- 最小实现：使用 frozen `RuntimeDependencies`，只暴露实际消费者需要的字段。
- 同步清理：把函数内延迟 import 移到正常模块边界，只有真实启动性能收益时才保留 lazy import。
- 验收：无字符串 key 访问；CLI、stdio server 和 API 使用同一个构造入口。

### A0.4 收紧异常与 best-effort 边界

- 优先级：P0
- 规则：
  - 取消必须优先传播为 cancellation，不得变成普通失败。
  - provider、tool、persistence 和 rendering 在边界处转换成明确错误类型。
  - `except Exception: pass` 仅允许用于明确标记的非关键诊断写入，并至少记录 debug event。
  - port 已声明的方法不再通过 `getattr` 猜测是否存在。
- 验收：测试能区分 cancelled、rejected、failed、timed_out 和 unavailable。

### A1.5 统一辅助函数但避免 util 大杂烩

- 优先级：P1
- 合并已有重复的整数解析、dict/attr 读取、取消检查、CJK/token 估算和格式化逻辑。
- 每个 helper 必须归属于明确领域，例如 `context/token_estimation.py`，不得创建无边界的 `utils.py`。
- 验收：重复实现删除；调用点名称表达领域含义。

## 8. 升级工作流 B：稳定运行时协议

### B0.1 为 stdio JSONL 协议加版本

- 优先级：P0
- 借鉴：Codex app-server protocol 的稳定 request/notification 边界。
- 最小实现：
  - initialize 握手返回 `protocol_version` 和 capability 列表。
  - request 包含 `request_id`；turn 包含 `session_id`、`turn_id`。
  - event 包含单调递增 `sequence`、`event_type`、`timestamp`。
  - 未知字段向前兼容，未知 event 由前端忽略并记录 debug 信息。
- 不做：代码生成、多版本服务器或庞大 schema 仓库。
- 验收：Node CLI、Python fallback 和 API 对同一 golden JSONL fixture 得到一致状态。

### B0.2 区分增量事件与持久事实

- 优先级：P0
- 增量事件：assistant delta、tool progress、status heartbeat，可丢弃或合并。
- 持久事实：用户消息、完整 assistant 消息、tool request/result、compaction、turn terminal state。
- 前端断线重连只需要 replay 持久事实，避免重放所有 token delta。
- 验收：中途断开后可恢复到一致 transcript；不会重复保存 assistant 内容。

### B0.3 有界队列与背压

- 优先级：P0
- 借鉴：Codex event protocol 与 Claude Code 关于慢消费者退出截断的公开修复经验。
- 最小实现：
  - 高频 delta 使用小型 coalescing buffer。
  - durable event 不可静默丢弃。
  - stdout 慢消费者触发有界等待和明确失败，不无限积累内存。
- 验收：模拟每秒只读取少量字节的消费者，进程内存保持有界且最终输出完整 terminal event。

### B0.4 steering 与 follow-up 输入队列

- 优先级：P0
- 借鉴：Pi 的两类消息队列，但在现有 runtime/stdio 协议内实现。
- 当前 Node CLI 的 `turnQueue` 只能顺序排队完整 turn；升级后：
  - steering 在当前模型消息要求的工具执行完毕后、下一次模型采样前注入。
  - follow-up 在 agent 没有更多工具调用并准备结束时，作为新用户输入继续。
- 默认一次投递一条；队列消息数和总字符数有小型上限。
- 队列归 runtime 所有，Node/Python CLI 只负责提交、展示和取回。
- 取消当前 turn 时，未投递输入恢复到编辑器或可由 `/queue` 取回。
- 不把未投递输入保存为已经发生的用户消息。
- 验收：用户可在长任务中纠正方向，follow-up 不会打断当前工具链，取消不会丢失文本。

### B1.5 Headless 执行模式

- 优先级：P1
- 命令建议：`rind exec --jsonl "prompt"`。
- 支持：stdin prompt、稳定 exit code、JSONL 事件、纯文本最终输出、取消信号。
- 不做：独立 daemon、远程队列或账号系统。
- 验收：可在 CI 中运行单回合任务并根据 exit code 判断完成、取消、拒绝或失败。

## 9. 升级工作流 C：权限、安全与审批

### C0.1 通用 `allow / ask / deny` 策略

- 优先级：P0
- 借鉴：OpenCode permission rules、Claude Code permissions、Codex approval protocol。
- 最小规则维度：
  - tool 名称
  - workspace 内外路径
  - shell 命令前缀与风险分类
  - 当前模式，例如 normal、plan、headless
- 规则优先级：session override > project settings > user settings > defaults。
- evaluator 必须是纯函数，返回 decision、reason 和可选持久规则建议。
- 验收：同一输入始终得到同一决策；所有决策有单元测试。

### C0.2 安全默认值

- 优先级：P0
- 建议默认：
  - workspace 内只读工具允许。
  - 读取 `.env`、凭据和常见密钥文件需要询问。
  - workspace 外读取需要询问，写入默认拒绝或询问。
  - 普通 workspace 文件编辑允许，但删除、覆盖大量文件和 Git 历史重写需要询问。
  - 计划模式拒绝文件修改。
  - headless 模式遇到 `ask` 默认失败，除非调用者显式提供策略。
- 验收：无交互环境不会因等待审批永久挂起。

### C0.3 shell 解析 fail closed

- 优先级：P0
- 当前 `bash_policy.py` 可作为初始实现，但只升级为保守的结构风险识别，不自建语法系统。
- 最小实现：
  - 识别 PowerShell、cmd、bash/sh 中最常见的控制操作符、重定向和跨 shell 调用。
  - 无法可靠解析的复杂命令返回 `ask`，而不是自动允许。
  - 超长命令、嵌套 shell、命令替换、设备文件和跨 shell 调用提高风险级别。
  - 审批展示进行 ANSI、控制字符和双向文本清理。
- 不做：自建完整 shell parser；超出小型规则能力的输入直接 `ask`。
- 验收：覆盖 PowerShell 5/7、bash、Git Bash 和 cmd 的代表性绕过用例。

### C0.4 会话级审批缓存

- 优先级：P0
- 用户可选择：允许一次、当前会话允许此前缀、拒绝。
- 缓存仅存具体规则，不存模糊自然语言结论。
- 规则必须展示实际命令 token 或路径模式，不能由模型自由生成通配符。
- 验收：会话结束后临时批准不泄漏到其他会话。

### C0.5 统一环境变量命名

- 优先级：P0
- 删除内部 `AGENT_ALLOW_UNSAFE_BASH`、`AGENT_SESSION_ROOT`、`AGENT_SESSION_ID`。
- 替换为必要的 `RIND_*`，或优先通过 task-local/context object 传递，避免环境变量承载并发状态。
- 特别要求：plan session 定位必须从当前 runtime/session 显式传递，禁止全局环境变量串会话。
- 验收：全仓库不存在非第三方的 `AGENT_*` 运行时接口。

### C1.6 可选 sandbox adapter

- 优先级：P3
- 借鉴：Codex sandbox 和 Claude Code sandbox 文档。
- 实现边界：
  - 先定义 `CommandSandbox` port，仅接收 cwd、环境、文件/网络权限和命令。
  - 默认 adapter 仍使用当前本地执行和审批。
  - 后续可接 Windows Sandbox、容器或受支持的系统隔离。
- 不做：在 Python 中模拟文件系统隔离或实现通用内核安全层。

### C1.7 敏感信息最小持久化

- 优先级：P1
- 工具参数、日志和错误在写盘前做字段级 redaction。
- 默认不把完整环境变量、authorization header、API key 或 `.env` 内容写入 session。
- debug 模式也只扩大技术细节，不取消 secret redaction。
- 验收：secret fixture 不出现在 session、日志、crash report 和 JSONL 输出中。

### C1.8 项目 trust

- 优先级：P1
- 借鉴：Pi 的 pre-trust/post-trust 资源加载边界。
- `RIND.md` 作为明确的项目指导文件可以加载并显示来源。
- 项目 `.rind/settings.json`、Skill、Prompt Template 以及未来可执行资源，只在项目被信任后生效。
- trust 按 canonical project path 保存到用户目录，支持仅本次、持久信任和忽略项目资源。
- 非交互模式不弹出问题；默认忽略未信任项目资源，可用明确 flag 覆盖。
- trust 只控制 Rind 项目资源，不替代工具权限策略。

## 10. 升级工作流 D：工具链精简与能力提升

### D0.1 统一 read / grep / glob 语义

- 优先级：P0
- 借鉴：OpenCode 小型文件工具和 Codex file search。
- 最小能力：
  - `read_file(path, offset, limit)` 返回行号、截断信息和编码状态。
  - `grep(pattern, path, glob, max_results)` 直接使用 `rg`。
  - `glob(pattern, path, max_results)` 使用 `rg --files` 或标准库。
  - 二进制、大文件、无权限和不存在必须有不同错误类型。
- 不做：常驻索引器或语义向量搜索。
- 验收：模型能从截断提示继续 offset read，不必重复读取全文件。

### D0.2 原子编辑与 preimage 校验

- 优先级：P0
- 借鉴：Codex apply-patch 和 OpenCode edit/apply_patch。
- 最小实现：
  - `apply_patch` 成为多处代码编辑的首选工具。
  - edit/write 在落盘前验证目标内容或 hash 未变化。
  - 使用同目录临时文件 + replace 完成原子写入。
  - 工具结果直接携带修改文件、行数和 diff 摘要。
- 验收：文件被外部修改时拒绝覆盖并返回可恢复错误。

### D0.3 输出截断与 artifact spill

- 优先级：P0
- 借鉴：OpenCode `tool/truncate.ts` 和 Codex output truncation。
- 最小实现：
  - terminal preview、model content 和磁盘 artifact 使用不同上限。
  - 超限输出写入 `RIND_HOME/artifacts/<session>/<tool-call>`。
  - tool result 返回 artifact ref、总字节数、总行数和建议读取方式。
  - artifact 有 TTL 清理，不进入 Git。
- 验收：100 MB 输出不会进入模型上下文或常驻内存；用户仍能定位完整结果。

### D0.4 单一 ProcessSupervisor

- 优先级：P0
- 目标：把前台、后台、等待、读取输出、取消、超时和清理统一到一个生命周期实现。
- 最小状态：starting、running、completed、failed、cancelled、timed_out。
- 必备行为：
  - stdout/stderr 流式 ring buffer。
  - 周期 heartbeat，长任务不静默。
  - Ctrl+C、turn cancel 和进程退出都清理整个 process tree。
  - 后台任务有 TTL 和最大数量。
  - shell session pool 关闭必须幂等。
- 验收：Windows 与 Unix 上取消后不留下子进程；无输入命令不会因继承 stdin 永久挂起。

### D0.5 通用工具循环保护

- 优先级：P0
- 从现有 `bash_output` 重复空轮询保护扩展为通用 guard：
  - 同参数连续调用次数上限。
  - 单 turn 工具调用上限。
  - 单 session Web 搜索、后台任务和委派上限。
  - 重复失败采用退避或终止提示。
- guard 只持久化计数和 tool call ID，不保存模型结论。
- 验收：模型陷入重复调用时能稳定停止，并给用户明确下一步。

### D1.6 有选择的工具并发

- 优先级：P1
- 仅并行执行显式标记为 `read_only` 且资源不冲突的调用。
- 文件写、shell、plan 更新、用户提问和同一 MCP server 调用默认串行。
- 并发数有小型固定上限，不根据模型一次请求无限扩张。
- 验收：并发读取提升延迟，同时 event sequence 和持久化顺序确定。

### D1.7 最小 MCP client

- 优先级：P3，按证据进入
- 进入条件：至少存在两个无法通过现有 CLI/HTTP 工具加 Skill 低成本解决的外部服务场景。
- 借鉴：OpenCode、Claude Code 与 Codex 均支持 MCP，但这不构成 Rind 的实施理由。
- 首期范围：
  - stdio 与 streamable HTTP 先选择真实场景需要的一种，不同时建设。
  - server list、connect、health、tool list、tool call。
  - lazy tool discovery，避免所有 schema 每轮进入上下文。
  - MCP 结果进入统一 `ToolExecutionResult` 和权限系统。
  - 每个 server 有超时、结果大小和并发上限。
- 不做：marketplace、OAuth UI、远程资源同步和 MCP 管理后台。
- 验收：断开的 MCP server 不影响内置工具；`/doctor` 能显示失败原因。

### D2.8 窄范围 LSP adapter

- 优先级：P3，可选
- 只在 `rg` + 文件读取无法满足导航体验时实现。
- 首期最多提供 diagnostics、definition、references，复用用户已有 language server。
- 不负责下载、升级、守护多语言 server。

## 11. 升级工作流 E：上下文、技能与压缩

### E0.1 固定上下文装配顺序

- 优先级：P0
- 建议顺序：
  1. system prompt
  2. user/project `RIND.md`
  3. 当前显式激活 skill
  4. plan 控制状态
  5. compaction continuation artifact
  6. 最近完整 turns
  7. 当前用户消息与工具边界
- 每段记录字符数、估算 token、截断原因和 source ID。
- 验收：`/context` 能解释每一段为什么存在及其成本。

### E0.2 技能改为严格显式激活

- 优先级：P0，保持现有设计
- 依据：当前 `SkillSelector` 已只接受 `$skill-name`；升级重点是消除静默失败并减少扫描成本，不重新设计匹配算法。
- 最小实现：
  - 普通 turn 不注入 skill index。
  - 只解析用户当前输入中的 `$skill-name`。
  - 激活后读取对应 `SKILL.md`，作用域仅当前 turn。
  - 不存在或冲突时返回明确事件。
- 验收：未显式引用时 skill token 成本为零。

### E0.3 增量 session API

- 优先级：P0
- 新增精确接口：latest user message、tail messages、message range、records since offset。
- runtime 不再为了一个字段读取完整会话。
- 存储层维护轻量 byte offset/index；index 可由 JSONL 重建。
- 验收：10,000 条消息会话读取最近 turn 的耗时不随总长度线性增长。

### E0.4 token 预算与 provider usage 对齐

- 优先级：P0
- 优先使用 provider 返回的 usage 作为校准锚点，字符估算只作为预估和无 usage fallback。
- CJK、代码、工具 schema 和图片使用不同估算策略。
- model capability 提供 context window 与 output reserve，不在 context manager 写死模型名称。
- 验收：连续真实请求后估算误差可测量；超限恢复不会无限降低全局 hard limit。

### E0.5 compaction 作为 continuation artifact

- 优先级：P0
- 借鉴：OpenCode 与 Codex 的压缩边界设计，同时遵守 `AGENTS.md`。
- 规则：
  - compaction summary 可以持久化为会话续接材料，但不作为项目事实库。
  - 记录被覆盖的 message ID 范围、生成模型、token usage、触发原因和 phase。
  - 保留最近完整 turn 与未闭合 tool boundary。
  - 工具输出优先裁剪，用户需求和已执行文件变更必须保留来源。
  - 不自动修改 `RIND.md`。
- 验收：manual、pre-turn、mid-turn 和 context-length recovery 都有边界测试。

### E1.6 prompt cache 友好装配

- 优先级：P1
- 稳定内容放在前缀，动态状态放在后部。
- `RIND.md` 和 skill 内容只在 turn 边界刷新。
- provider 不支持 prompt caching 时行为不变。
- 验收：支持 usage cache 字段的 provider 可展示命中率，切换模型时给出一次性缓存失效提示。

### E1.7 `/context` 可解释视图

- 优先级：P1
- 展示：预算、已用、保留输出空间、各段成本、最近 compaction、截断 artifact。
- 默认只展示聚合数据，不泄露 secret 或完整 system prompt。
- 验收：用户能判断 token 消耗来自文件、skill、工具输出还是历史会话。

## 12. 升级工作流 F：会话、checkpoint 与恢复

### F0.1 加固现有 session schema 2.0

- 优先级：P0
- 不平行新增另一套 session envelope；直接演进现有 `messages.jsonl`、`tool_calls.jsonl`、`compactions.jsonl` 和 meta。
- 持久事实逐步补齐稳定的 record ID、turn ID、类型和 timestamp。
- 新字段向前兼容；破坏性变化通过小型 migration 函数处理。
- migration 必须可重复运行并保留原始数据备份或可重建路径。
- 验收：旧 fixture 可升级，新版本能拒绝无法识别的重大版本。

### F0.2 单会话单 writer 与损坏尾修复

- 优先级：P0
- 同一 session 的写入通过 async lock 和单一 append path 完成。
- JSONL 最后一行被中断时，加载器识别并隔离损坏尾，不丢弃此前记录。
- meta/index 使用 atomic replace，不在每个 context build 写入大 snapshot。
- 验收：并发写、进程中断和 Windows 文件占用 chaos tests 通过。

### F0.3 明确 session/turn 状态机

- 优先级：P0
- terminal state：completed、cancelled、failed、interrupted。
- 启动时将没有 terminal record 的旧 turn 标为 interrupted，并允许继续。
- 状态从记录投影，不通过多个布尔字段组合推断。
- 验收：resume 后不会重复执行已完成工具，也不会把取消显示为失败。

### F1.4 单回合 checkpoint 与 `/undo`

- 优先级：`/diff` 为 P1，checkpoint 与 `/undo` 为 P2
- 借鉴：Claude Code checkpoint 和 OpenCode revert，但缩小为 agent 触及文件。
- 先使用现有 `FileChangeEvent` 和 Git 实现 `/diff`。只有 `/diff` 稳定后才进入以下 checkpoint 实现：
  - 首次写某文件前记录 preimage hash、存在状态和恢复内容。
  - turn 结束记录 postimage hash。
  - `/diff` 展示本回合变化。
  - `/undo` 仅在当前文件仍匹配 postimage 时恢复；有外部变化则拒绝并提示。
  - 大文件使用 Git blob/patch 或受限 artifact，避免无限复制。
- 不做：全文件系统快照、自动 Git commit 或无冲突检测的覆盖恢复。
- 验收：新增、修改、删除、外部冲突和未跟踪文件均有测试。

### F1.5 会话 fork

- 优先级：P1
- 借鉴 Pi 的分支体验，但首版不迁移为单文件 `id/parentId` 树。
- 从指定用户 turn 创建新 session，流式复制该点之前的有效持久事实并写入新 metadata。
- 不复制后台进程、临时审批和活动 plan lock。
- 验收：原会话与 fork 后续写入完全隔离。
- 只有当真实使用表明频繁分支且复制成本成为可测瓶颈时，才评估树形 JSONL 和 `/tree` UI。

### F1.6 retention 与 cleanup

- 优先级：P1
- 对 artifacts、已完成后台任务输出、损坏尾备份和旧索引设置保守 TTL。
- 会话本身不自动删除，除非用户明确执行清理命令。
- `/doctor` 报告可回收空间，不在启动关键路径执行大量扫描。

## 13. 升级工作流 G：Provider 与模型能力

### G0.1 不可变配置快照

- 优先级：P0
- 将 mutable `Config` class attributes 收敛为 frozen `AppSettings`。
- 每个 runtime/session 接收自己的配置快照，切换模型生成新 turn configuration，不改全局变量。
- 配置层级：CLI flags > environment > settings file > defaults。
- 设置解析错误包含路径和字段，不在 import 时产生文件 I/O 或网络 client。
- 验收：两个并发 session 可使用不同模型和 base URL，互不污染。

### G0.2 ProviderCapabilities

- 优先级：P0
- 只声明运行时确实使用的能力：tools、stream usage、reasoning effort、prompt cache、image input、context window。
- context manager 和 CLI 根据能力降级，不根据模型字符串猜测。
- 验收：OpenAI-compatible provider 缺少某字段时仍能完成普通 turn。

### G0.3 有界 retry classifier

- 优先级：P0
- 区分：authentication、rate limit、server error、network reset、invalid request、context length、cancelled。
- 仅对可恢复错误重试，遵守 `Retry-After`，使用 jitter 和总时间上限。
- 每次重试发出状态事件，允许取消。
- 验收：401 不重试；429/5xx 有界重试；连接恢复后不重复持久化消息。

### G1.4 保持 provider 数量克制

- 优先级：P1
- 首先完善 OpenAI-compatible adapter。
- 只有明确用户需求和测试资源时再增加 Anthropic direct adapter。
- 不建立维护成本高的 provider catalog；自定义 base URL 继续覆盖多数兼容服务。

### G1.5 跨 Provider handoff

- 优先级：P1
- 借鉴 Pi 的统一消息边界，但只转换 Rind runtime 已使用的字段。
- user、assistant、tool request/result 使用标准内部表示；Provider 私有 reasoning/thinking block 不作为可执行事实跨 Provider 搬运。
- 切换模型不会重复持久化消息，能力不支持时明确降级。
- 不引入通用内容转换 DSL。

### G1.6 usage 与成本

- 优先级：P1
- 记录 input、cached input、output、reasoning token 和请求耗时。
- 成本只在配置有价格表时估算，未知价格显示 token 而不是猜测金额。
- `/status` 展示当前 turn/session 聚合值，默认不持续刷新复杂图表。

## 14. 升级工作流 H：CLI 与用户体验

### H0.1 收敛双 CLI 职责

- 优先级：P0
- 推荐过渡方案：
  - Python runtime 是唯一业务实现。
  - Node CLI 只负责输入、终端状态机和 event rendering。
  - Python `ChatCLI` 降为最小 fallback/debug 界面，不重复实现 slash command 业务规则。
  - slash command 在 runtime server 执行，前端只做菜单和展示。
- 最终选择：通过启动速度、包体积、终端稳定性和 Windows 分发基准决定保留哪个完整交互 renderer；另一套降级为 thin client 或删除。
- 验收：同一命令在不同前端返回相同 structured result。

### H0.2 工作期间输入与队列

- 优先级：P0
- 工作中提交默认作为 steering；用户可明确选择 follow-up。
- 推荐交互参考 Pi：Enter 提交 steering、Alt+Enter 提交 follow-up、Escape 取消、Alt+Up 取回队列。
- Windows Terminal 或当前 TTY 无法传递快捷键时，提供 `/queue steer`、`/queue follow` 和 `/queue pop` 文本降级，不要求用户修改终端配置才能使用核心能力。
- 模型流、工具输出、heartbeat 和错误不得窃取光标或破坏当前输入。
- 队列状态使用简短数量/类型提示，不增加常驻面板。

### H1.3 高价值 slash commands

- 优先级：P1
- 建议新增或完善：
  - `/context`：上下文预算和来源。
  - `/permissions`：当前策略和临时批准。
  - `/queue`：查看、取回或清空尚未投递的输入。
  - `/diff`：当前或最近 turn 文件变化。
  - `/undo`：有限 checkpoint 恢复。
  - `/fork`：从当前 durable point 创建会话。
  - `/export`：脱敏导出 transcript。
  - `/doctor --json`：机器可读诊断。
- 每个命令必须是 runtime capability，不能只存在于某个 renderer。

### H1.4 文件引用与快速搜索

- 优先级：P1
- 输入中的 `@path` 使用 `rg --files` 做模糊候选，按最近使用与路径匹配排序。
- 只注入用户最终选择的文件，不自动读取所有候选。
- 对粘贴的大段文本先显示字符数并按需写入临时 artifact。
- 验收：大型仓库搜索不会阻塞输入或引入常驻索引。

### H2.5 shell 快捷模式

- 优先级：P2
- 支持明确的 `!command` 用户直连 shell 模式。
- 仍通过 ProcessSupervisor、权限和输出截断执行。
- shell 输出不自动交给模型；用户显式继续提问时再引用相应 artifact/tool result。

### H0.6 稳定渲染与无障碍降级

- 优先级：P0
- 保留现有 CJK、emoji、窄终端和输入缓冲测试。
- 高频 delta 合并到固定刷新周期，不能每 token 全屏重绘。
- 非 TTY、`NO_COLOR`、屏幕阅读器和重定向输出使用纯文本模式。
- resize、后台日志和 tool heartbeat 不能窃取输入光标。
- 验收：长 turn、窗口调整、100 KB 错误和慢流输出下无布局重叠。

### H0.7 可操作错误格式

- 优先级：P0
- 默认错误只展示：发生了什么、可执行的下一步、短 error ID。
- debug 模式通过 error ID 查看 stack、provider response 和 protocol detail。
- 网络、配置、权限、文件冲突、MCP 和模型错误使用不同建议。
- 验收：普通错误不输出无界 stack trace，rendering error 不终止 runtime。

## 15. 升级工作流 I：轻量资源与扩展边界

### I1.1 小型 `ResourceLoader`

- 优先级：P1
- 借鉴 Pi 的资源发现、优先级和 trust，但只支持 Rind 真实需要的资源。
- 首期只统一：
  - 用户级与项目级 `RIND.md`。
  - `~/.rind/skills` 与 `.rind/skills`。
  - 用户级与项目级 Prompt Template。
  - settings 的来源、优先级、trust 和诊断。
- 使用 mtime/size 做 turn 边界缓存，文件变化后自然失效。
- 同名资源按“显式 CLI > 已信任项目 > 用户”解析并报告覆盖来源。
- 不支持 theme、extension、package install、marketplace 或依赖解析。

### I1.2 Prompt Template

- 优先级：P1
- 借鉴 Pi 的 Prompt Template，只实现 Markdown 文本和少量位置参数。
- 用户通过 `/prompt <name> [args]` 或补全选择；模板展开到编辑器，提交前可修改。
- 模板不执行代码、不隐式调用工具、不新增权限能力。
- 这是比通用插件系统更轻、更容易审计的工作流复用方式。

### I2.3 扩展方式各司其职

| 扩展方式 | 用途 | 不承担的职责 |
| --- | --- | --- |
| Skill | 当前 turn 的专项指令与参考资料 | 长期后台服务、隐式自动记忆 |
| Prompt Template | 可编辑的重复提示和工作流起点 | 执行代码、自动调用工具 |
| Hook | 生命周期校验、通知和策略补充 | 新的模型工具协议、复杂 UI |
| MCP | 外部工具和数据服务 | 修改核心 runtime、覆盖权限系统 |

Hook 与 MCP 均为 P3。出现真实需求时先选择更合适的一种，不并行建设两套扩展基础设施。

### I3.4 暂缓通用插件系统

- 优先级：P3
- 只有当同一个扩展需要同时分发 skill、Hook 和 MCP 配置，且已出现至少两个真实使用案例时，再定义小型 bundle manifest。
- 不实现 marketplace、自动更新、依赖解析和任意进程注入。

## 16. 升级工作流 J：性能与资源控制

### J0.1 建立基准再优化

- 优先级：P0
- 首批 benchmark：
  - `rind --version` 与交互启动时间。
  - runtime initialize 时间。
  - 1,000 / 10,000 message 会话 resume 时间。
  - 10 MB / 100 MB shell 输出峰值内存。
  - Node renderer 在高频 delta 下 CPU 与刷新次数。
  - Windows EXE 冷启动时间和 installer 体积。
- 结果记录在机器可读 JSON，不把一次本机数据当作绝对标准。

### J0.2 启动路径瘦身

- 优先级：P0
- `--version`、`--help` 和 `--doctor` 不加载 provider client、session store 或完整工具实现。
- 配置加载不在模块 import 时创建网络 client。
- skill、MCP、PDF 和 Web adapter 按需加载。
- 验收：轻命令不触碰 session 目录，不创建 settings 之外的运行时文件。

### J0.3 会话与上下文增量化

- 优先级：P0
- 依赖 E0.3。
- 避免每轮：完整 JSONL 读取、完整 meta 重写、完整 skill index 重建和重复 schema 序列化。
- 使用 mtime/size cache 缓存 `RIND.md` 和显式 skill，文件变化后下一 turn 失效。

### J0.4 流式渲染合并

- 优先级：P0
- assistant delta 和 tool progress 使用时间片合并，terminal writer 单线程化。
- 完整行优先输出，输入活跃时保留尾部 draft。
- 验收：token 速率提升时 CPU 不随 event 数量线性爆炸。

### J0.5 依赖和包体积预算

- 优先级：P0
- 每个新增 runtime dependency 必须记录：用途、替代方案、安装体积、安全维护和删除条件。
- 一个阶段的分发体积增长超过 10% 必须有用户价值说明。
- 开发依赖与 runtime 依赖分离；PDF、MCP、OTEL 等可选能力尽量使用 extras 或延迟依赖。

## 17. 升级工作流 K：可靠性、可观测性与测试

### K0.1 统一关联 ID

- 优先级：P0
- session、turn、request、tool call 和 process 都有稳定 ID。
- log、RuntimeEvent、session record 和 artifact ref 使用同一组 ID。
- 验收：从用户看到的 error ID 可以定位到本地 debug log，不需要搜索模型文本。

### K0.2 结构化本地日志

- 优先级：P0
- 默认写有界、轮转、脱敏 JSONL log。
- 字段控制在时间、级别、component、event、IDs、duration、error type 和必要 metadata。
- 不默认记录 prompt、文件内容或完整 tool output。
- OTEL 作为 P3 可选 adapter，不成为核心依赖。

### K0.3 `/doctor` 能力矩阵

- 优先级：P0
- 检查：Python、Node（如需要）、shell、Git、settings、provider endpoint、session 目录、权限、MCP、包版本和可写路径。
- 输出明确区分 pass、warning、failure 和 skipped。
- `--json` 使用稳定 schema，便于安装器和 CI 调用。

### K0.4 测试分层

- 优先级：P0
- 单元测试：纯策略、parser、state reducer、record codec。
- contract 测试：tool result、RuntimeEvent、stdio JSONL、settings migration。
- 集成测试：真实临时目录、subprocess、session resume、checkpoint。
- chaos 测试：截断写入、锁冲突、慢消费者、取消、超大输出、无效 UTF-8、网络重试。
- packaging smoke：`rind.exe --help`、`--version`、`--doctor`、最小本地会话。

### K0.5 跨平台矩阵

- 优先级：P0
- 至少覆盖 Windows PowerShell 7、Windows Git Bash 和 Linux bash。
- 路径、Unicode、CJK 宽度、CRLF、ANSI、process tree 和信号行为必须有平台测试。
- 不支持的 shell 功能明确降级，不通过隐藏分支假装支持。

### K1.6 性能回归门槛

- 优先级：P1
- 建议门槛：
  - 无模型的 turn framework overhead 不高于基线。
  - 10,000 message resume 相对基线至少降低 50%。
  - 100 MB 工具输出峰值内存保持有界，不接近输出大小。
  - 取消后 2 秒内完成本地清理；超时平台可记录例外。
  - 高频流渲染刷新次数显著低于 event 数量。
- CI 中只执行稳定微基准；硬件敏感基准作为发布前检查。

## 18. 可选高级能力及进入条件

### 18.1 受限 subagent

- 优先级：P3
- 进入条件：单代理的权限、checkpoint、事件协议和 session isolation 已稳定。
- 最小形态：
  - 只允许用户或主模型显式委派独立、只读或独立 worktree 任务。
  - 子代理有独立 context 和 session，继承更严格权限。
  - 默认并发 1-2，必须有 spawn budget。
  - 返回结构化结果和来源，不把全部 transcript 塞回主上下文。
- 不做：自由递归代理、常驻团队和默认 swarm。

### 18.2 Git worktree 隔离

- 优先级：P3
- 只服务于并行写任务或显式 fork。
- 创建、路径验证、清理和未提交变化必须由确定性代码处理。
- 工作区存在用户未提交变化时不得隐式迁移或删除。

### 18.3 Review 模式

- 优先级：P2
- 使用现有 runtime + 只读权限 + Git diff 工具实现。
- 输出 findings，按严重度和文件行号排序；不自动修改代码。
- 不需要单独 agent framework。

### 18.4 图片输入

- 优先级：P3
- 仅在 provider capability 支持时开放本地图片附件。
- 进行尺寸、格式、文件大小和路径权限检查。
- 不引入图像编辑或视觉工作台。

## 19. 建议删除或收敛的内容

升级不仅增加能力，还应主动删除重复与隐式行为：

1. 删除所有 `AGENT_*` 内部环境变量接口。
2. 删除 Python CLI 与 Node CLI 中重复的 slash command 业务判断。
3. 删除每次 tool call 的动态 signature 检查。
4. 删除 runtime 对 port 方法的 `getattr` 能力猜测。
5. 删除未显式激活时的 skill index 注入。
6. 删除完整 context snapshot 高频写入 meta 的行为。
7. 删除工具 processor 中按工具名称重建 file diff 的分支。
8. 删除无来源的模型事实摘要或 observation 持久化计划。
9. 删除已被 RuntimeEvent 替代的 callback 和并行状态通道。
10. 删除仅为未来可能性存在、没有消费者的接口与字段。
11. 在 frontend protocol 稳定后，删除一套重复的完整交互 renderer。
12. 将失效的专项计划标记 archived，避免后续代理重复执行。

## 20. 分阶段实施路线

### Phase 0：先做减法

目标：不改变用户行为，先缩短后续升级路径。

包含：

- A0.1-A0.4 超长模块、`ToolSpec`、composition root 和异常边界收敛。
- G0.1 不可变配置快照。
- J0.1 性能基线与 J0.2 轻命令启动瘦身。
- 记录当前 RuntimeEvent、stdio JSONL、session schema 和 CLI golden fixtures。
- 只为高风险边界补 contract 测试，不先建设大而全的测试框架。

退出条件：现有测试通过；CLI 可观察行为不变；没有新增 runtime dependency；能力猜测和重复业务逻辑明显减少。

### Phase 1：直接改善日常体验

目标：让用户在真实长任务中更容易控制、更安全、更不容易丢失工作。

包含：

- B0.1-B0.4 稳定事件、背压和 steering/follow-up 队列。
- C0.1-C0.5 最小权限、审批和命名清理。
- D0.1-D0.5 文件工具、原子编辑、输出 artifact、ProcessSupervisor 和 loop guard。
- E0.1-E0.5 上下文顺序、现有显式 Skill、增量读取、预算和 compaction。
- F0.1-F0.3 session single writer、损坏尾修复和终态。
- H0.1/H0.2/H0.6/H0.7 CLI 职责、工作期间输入、稳定渲染和错误体验。

退出条件：工作中可纠正方向；取消不丢队列；大输出内存有界；危险操作不会静默执行；session 损坏尾可恢复；终端输入稳定。

### Phase 2：连续性与程序化使用

目标：提升长会话、跨会话、项目资源和自动化场景体验。

包含：

- B1.5 `rind exec --jsonl`。
- C1.7/C1.8 secret redaction 与项目 trust。
- F1.5 复制式 fork；F1.4 先交付 `/diff`，不同时承诺 `/undo`。
- G0.2-G1.6 Provider capability、retry、handoff 和 usage。
- H1.3/H1.4 高价值命令与 `@path`。
- I1.1/I1.2 小型 ResourceLoader 与 Prompt Template。
- K0.1-K0.5 IDs、日志、doctor、必要 contract/chaos 和跨平台测试。

退出条件：长会话无需为 tail read 全量扫描；interactive/exec/API 使用同一行为；项目资源来源和 trust 可解释；源码、Node bin 与 Windows EXE 核心命令一致。

### Phase 3：按证据扩展

目标：只实现已被真实场景证明的高级能力。

候选顺序：

1. Review 模式或单个专用 Provider/外部工具 adapter。
2. MCP 或 Hook 中更必要的一种，不同时建设。
3. 具备 preimage/postimage 冲突检测的有限 `/undo`。
4. 受限 subagent 与 worktree。
5. LSP、sandbox、图片输入、OTEL 或 plugin bundle。

退出条件：每项单独立项、单独验收，不以“完成全面升级”或“竞品已经支持”为实施理由。

## 21. 优先级总表

| ID | 工作项 | 用户价值 | 复杂度 | 建议阶段 |
| --- | --- | --- | --- | --- |
| A0.1 | 超长模块拆分 | 中 | 中 | 0 |
| A0.2 | ToolSpec | 高 | 中 | 0 |
| A0.3 | RuntimeDependencies | 中 | 低 | 0 |
| G0.1 | 不可变配置 | 高 | 中 | 0 |
| B0.1 | 协议版本化 | 高 | 中 | 1 |
| B0.3 | 背压与有界队列 | 高 | 中 | 1 |
| B0.4 | steering/follow-up | 极高 | 中 | 1 |
| C0.1 | allow/ask/deny | 极高 | 中 | 1 |
| C0.3 | shell 保守风险识别 | 极高 | 中 | 1 |
| C0.5 | 移除 AGENT_* | 高 | 低 | 1 |
| F0.1 | 加固 session schema 2.0 | 高 | 中 | 1 |
| F0.2 | single writer/repair | 极高 | 中 | 1 |
| D0.2 | 原子编辑 | 极高 | 中 | 1 |
| D0.3 | 输出 artifact | 极高 | 中 | 1 |
| D0.4 | ProcessSupervisor | 极高 | 高 | 1 |
| E0.2 | 保持显式 Skill | 高 | 低 | 1 |
| E0.3 | 增量 session read | 高 | 中 | 1 |
| E0.5 | compaction 边界 | 极高 | 中 | 1 |
| H0.1 | 双 CLI 收敛 | 高 | 高 | 1-2 |
| C1.8 | 项目 trust | 高 | 中 | 2 |
| F1.5 | 复制式 fork | 高 | 中 | 2 |
| I1.1 | ResourceLoader | 高 | 中 | 2 |
| I1.2 | Prompt Template | 中 | 低 | 2 |
| F1.4 | diff/有限 undo | 高 | 中 | 2/3 |
| D1.7 | MCP client | 条件性高 | 高 | 3 |
| Hook | 生命周期扩展 | 条件性中 | 中 | 3 |
| 18.1 | subagent | 条件性高 | 高 | 3 |
| D2.8 | LSP | 条件性中 | 高 | 3 |

## 22. 文件级实施映射

| 当前路径 | 主要升级方向 |
| --- | --- |
| `main.py` | 轻量参数分发、headless 入口、避免重依赖启动 |
| `agent/bootstrap/container.py` | `RuntimeDependencies`、配置快照、provider/tool/permission wiring |
| `agent/domain/events.py` | versioned RuntimeEvent、sequence、IDs、queue 与 terminal states |
| `agent/application/runtime/async_turn_runner.py` | 缩短 turn loop，处理 steering/follow-up，抽离 retry/compaction 纯策略 |
| `agent/application/runtime/model_stream_pump.py` | 有界合并队列、背压和取消 |
| `agent/application/runtime/async_tool_call_processor.py` | 依赖 ToolSpec、permission 和 loop guard；删除工具名特判 |
| `agent/application/services/context_manager.py` | 固定装配顺序、增量 session API、context diagnostics |
| `agent/application/services/compaction_service.py` | source ranges、phase、tail preservation、边界 contract |
| `agent/infrastructure/config/` | immutable settings、layering、provider capability |
| `agent/infrastructure/persistence/` | 加固 schema 2.0、single writer、轻索引、repair、migration、复制式 fork |
| `agent/infrastructure/tools/registry.py` | ToolSpec catalog 与预计算调用信息 |
| `agent/infrastructure/tools/impl/tools/bash_*` | ProcessSupervisor、权限、ring buffer、process tree cleanup |
| `agent/infrastructure/tools/impl/tools/file_ops.py` | read/search/apply_patch/atomic write/preimage check |
| `agent/infrastructure/plans/` | 显式 session context，移除环境变量定位 |
| `agent/infrastructure/skills/` | 保持显式 `$skill-name`，增加 trust、来源诊断和 mtime cache |
| `agent/interfaces/runtime_server/stdio.py` | 协议握手、capability、steering/follow-up、durable replay、headless control |
| `agent/interfaces/cli/` | fallback/debug UI，slash result 展示，不保存业务状态 |
| `frontend-cli/` | 输入、队列和 rendering state；移除业务分支；拆分超长文件 |
| `packaging/` | doctor smoke、可选依赖、包体积基准 |
| `test/` | 按模块拆分超长测试，增加 queue、permission、contract、repair 和平台边界 |

## 23. 每个实施 PR 的硬性约束

1. 说明解决的本文工作项 ID。
2. 保持改动范围单一，不在功能 PR 中顺带重构无关模块。
3. 新功能至少覆盖 success、failure 和一个 edge case。
4. 新跨模块实体必须解释为何局部函数或现有类型不够。
5. 新配置必须有默认值、文档、验证和错误信息。
6. 新持久字段必须有 schema version 或兼容读取策略。
7. 新运行时依赖必须记录体积、许可证和替代方案。
8. 所有集合、队列、输出、重试、并发和后台任务必须有上限。
9. 不把模型生成的 summary、observation 或 conclusion 当作长期事实。
10. 不自动修改 `RIND.md`，除非用户明确请求或执行 `/init`。
11. 不引入未使用接口、永久 feature flag 或“以后可能用到”的字段。
12. 完成后运行与风险相称的 Python、Node、协议、Windows 和打包验证。

## 24. 发布验收指标

### 24.1 功能

- 真实代码任务可以完成搜索、读取、编辑、命令、测试、恢复和继续。
- CLI、headless、API 对同一 runtime event contract 行为一致。
- `/context`、`/permissions`、`/diff`、`/undo` 和 `/doctor` 可独立使用。
- MCP 或 Hook 不可用时内置能力正常运行。

### 24.2 可靠性

- crash 后 session 可加载，损坏尾不影响此前记录。
- cancellation、timeout 和 permission rejection 有不同 terminal state。
- 工具超大输出、慢消费者和重复调用不会造成无界内存。
- 并发 session 不共享 model、plan、permission 或 active skill 状态。

### 24.3 安全

- workspace 外写入、危险 shell 和秘密文件读取不会静默自动允许。
- 审批文本经过终端控制字符清理。
- session、日志、artifact 和导出默认脱敏。
- headless 模式没有隐藏的交互等待。

### 24.4 性能

- 轻命令启动不加载完整 runtime。
- 长会话 tail read 不随总历史线性退化。
- terminal 刷新频率有界。
- 包体积和依赖增长有明确收益说明。

### 24.5 代码质量

- Python 文件符合 `AGENTS.md` 行数约束。
- 核心状态使用明确类型，局部实现保持直接。
- 无重复业务逻辑、无未使用抽象、无跨层反向依赖。
- 工具结果继续统一使用 `tool_ok` / `tool_error`。

## 25. 推荐的第一批实际任务

为避免一次升级触碰所有主链路，建议从以下五个独立任务开始：

1. `refactor(runtime): simplify turn loop boundaries`
   - 删除 port 能力猜测，抽出 compaction/retry 纯策略，固定终态。
2. `refactor(tools): introduce a minimal tool spec catalog`
   - 合并 schema、handler、effect、permission 和输出限制。
3. `feat(runtime): add steering and follow-up input queues`
   - runtime 持有语义，Node/Python CLI 只负责投递与显示。
4. `feat(security): add deterministic permission decisions`
   - 只覆盖内置工具、workspace 路径和 shell 风险，不做 sandbox。
5. `fix(runtime): bound model streams and large tool output`
   - delta 合并、慢消费者背压和超限 artifact。

完成这五项后，再实施 session repair/增量读取、项目 trust、Prompt Template 和 `rind exec --jsonl`。MCP、Hook、subagent、LSP 和完整 `/tree` 不进入第一批。

## 26. 参考实现索引

### 26.1 Pi

- [Coding agent README](../../pi/packages/coding-agent/README.md)
- [核心 agent loop](../../pi/packages/agent/src/agent-loop.ts)
- [Agent queue API](../../pi/packages/agent/src/agent.ts)
- [Agent session](../../pi/packages/coding-agent/src/core/agent-session.ts)
- [JSONL session manager](../../pi/packages/coding-agent/src/core/session-manager.ts)
- [Resource loader](../../pi/packages/coding-agent/src/core/resource-loader.ts)
- [Project trust](../../pi/packages/coding-agent/src/core/trust-manager.ts)
- [Package/resource precedence](../../pi/packages/coding-agent/src/core/package-manager.ts)
- [Provider API](../../pi/packages/ai/README.md)

### 26.2 OpenCode

- [Agent 与默认权限](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/agent/agent.ts)
- [Permission evaluator](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/permission/evaluate.ts)
- [Session compaction](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/session/compaction.ts)
- [Tool registry](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/tool/registry.ts)
- [Tool output truncation](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/tool/truncate.ts)
- [Project config paths](https://github.com/anomalyco/opencode/blob/a19b52e85bf2630b86157030e2cf7c9fc20ce552/packages/opencode/src/config/paths.ts)

### 26.3 Codex

- [Core compaction](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/compact.rs)
- [Approval protocol](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/protocol/src/approvals.rs)
- [Execution policy](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/exec_policy.rs)
- [Shell snapshot lifecycle](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/shell_snapshot.rs)
- [AGENTS.md manager](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/agents_md_manager.rs)
- [App-server protocol schemas](https://github.com/openai/codex/tree/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/app-server-protocol/schema)
- [TUI event handling](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/tui/src/app_event.rs)

### 26.4 Claude Code

- [公开仓库](https://github.com/anthropics/claude-code/tree/015170d3fd84fb57ef4685a64b673fadd0690dc1)
- [官方插件结构](https://github.com/anthropics/claude-code/blob/015170d3fd84fb57ef4685a64b673fadd0690dc1/plugins/README.md)
- [Hook command validator 示例](https://github.com/anthropics/claude-code/blob/015170d3fd84fb57ef4685a64b673fadd0690dc1/examples/hooks/bash_command_validator_example.py)
- [严格 sandbox 设置示例](https://github.com/anthropics/claude-code/blob/015170d3fd84fb57ef4685a64b673fadd0690dc1/examples/settings/settings-strict.json)
- [公开变更记录](https://github.com/anthropics/claude-code/blob/015170d3fd84fb57ef4685a64b673fadd0690dc1/CHANGELOG.md)
- [Permissions 文档](https://code.claude.com/docs/en/permissions)
- [Hooks 文档](https://code.claude.com/docs/en/hooks)
- [Checkpointing 文档](https://code.claude.com/docs/en/checkpointing)
- [Context window 文档](https://code.claude.com/docs/en/context-window)
- [MCP 文档](https://code.claude.com/docs/en/mcp)
- [Subagents 文档](https://code.claude.com/docs/en/sub-agents)

## 27. 最终判断标准

每个候选升级在进入实现前，用以下顺序判断：

1. 是否解决已经存在、可以复现的问题。
2. 是否明显改善真实用户完成任务的时间、成功率、控制感或安全性。
3. 是否能减少工具往返、删除重复逻辑或保持核心 loop 不变长。
4. 是否能通过小型、明确、可测试的实现完成。
5. 是否有有界资源、失败路径、迁移策略和降级行为。
6. 未启用时是否接近零启动、上下文和运行时开销。
7. 如果不实现，用户是否仍能通过现有 CLI 工具、Skill 或 Prompt Template 完成目标。

只有前六项成立，且第七项的简单替代方案明显不足时，功能才应进入 P0-P2。否则保留为 P3 候选，不进入核心路线。

这项标准比“竞品已经支持”更重要。Rind 的优势不应来自功能数量，而应来自用更短、更清楚的实现提供足够完整、稳定和舒服的编码体验。
