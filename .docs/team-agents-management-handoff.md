# Team Agents Management 续接凭证

本文是 Team Agents Management 的产品、架构和实现交接文档。新 session 开始工作前应先阅读本文，再阅读本文列出的源文件和测试。本文记录的是当前仓库真实状态；设计愿景与已实现行为分开描述。

## 0. 当前基线

- 仓库：Rind。
- 分支：`feature/team-agents-management`。
- 当前提交：`0baf9d4 feat(cli): refine agents terminal interaction`。
- 工作树在本次文档创建前干净；本文件是本次唯一新增文件。
- CLI 继续使用现有 TypeScript/Node TUI。Rust + Ratatui 迁移没有作为 CLI surface 落地；不要重新创建 `cli-rs` 或以 Rust 替换当前 frontend-cli。
- 设计规格：[`.docs/team-agents-management-design.md`](./team-agents-management-design.md)。
- 用户可读使用说明：[`docs/agents-management.md`](../docs/agents-management.md)。
- 当前 Rind 架构：[`docs/architecture.md`](../docs/architecture.md)。
- 当前 CLI 渲染约束：[`docs/cli-rendering.md`](../docs/cli-rendering.md)。

最近的实现提交按演进顺序为：

1. `83accd6`：加入 CLI Agents Management、任务交付和 scoped session 基础。
2. `3fcea13`：改为页面式管理交互和工作流。
3. `84dc536`：固定 Manager 专属 workspace。
4. `626582e`、`9ee6db5`：统一成员状态、任务协调和 briefing。
5. `c91a8dd`：共享 Runtime 宿主和隔离 Session。
6. `fdb67ff`：汇报树、权限边界和共享 Session 恢复。
7. `ffbbc5f`：组织树、全局 Overview 和成员 Session 浏览。
8. `0baf9d4`：TypeScript TUI 的全屏 Agents 页、终端主题、鼠标协议和更完整的键盘导航。

## 1. 产品定义

一句话：**Agents Management 是独立于 Rind Worker 的本地控制面，负责管理持久的 Agent 身份、任意 Workspace 组成的 Team、层级分工、任务调度、Session 观察和交付；Rind 只是首个执行适配器。**

### 1.1 核心理念

- Agent 不是一次性进程，而是“稳定身份 + Workspace + 执行适配器 + 可选短指引/Skill 引用”。
- Workspace 保存项目文件、岗位私有材料、历史状态和产物；Skill 保存可复用的能力与 reference。二者互补，Skill 不替代持久 Workspace。
- Team 是注册关系，不是目录父子结构。任何现有文件夹都可以成为成员；一个 Agent/Workspace 可以被多个 Team 引用，但共享必须显式确认。
- Manager 是独立、受控、跨 Team 的 Agent。它知道 Team、成员、任务、Session 和运行状态，但默认没有成员 Workspace 私有文件权限。
- Team 通常有且只有一个 main-agent/Leader。其他成员通过 `reportsToAgentId` 形成汇报树：直属下属由上级调遣并向上级汇报；树可以多层，不能有环。
- 人类不应逐个管理无限并行 Agent。调度、队列、阻塞路由、自动唤醒、运行恢复和一页式交付是产品核心，而不是附加功能。
- Agent 间协作以可追踪 Task、Report、Note、Artifact 为协议。旧的 Worker 内 `delegate` 不是新控制面的基础；旧路径只用于兼容/迁移。
- UI 必须让用户先看懂“Team → 成员 → Session/Task 状态”，再进行动作；不能要求用户先理解 Capsule、Blueprint 或目录约定。

### 1.2 明确不做的事情

首版不做远程多机控制、企业多租户、预算/审批体系、复杂 DAG 编排、跨 Team 自动共享私有文件，也不假装可以观测未接入本控制面的外部 Codex/Claude 进程。未来可以接入这些适配器，但不能把 provider 特例塞进 Team 核心。

## 2. 概念和关系

```text
Manager（全局受控 Agent）
  ├── Team A
  │     └── Leader
  │           ├── Member A1
  │           │     └── Session(s)
  │           └── Member A2
  │                 └── Session(s)
  └── Team B
        └── Leader ...
```

概念边界：

- **Workspace**：规范化的真实文件夹，承载文件和 Rind 历史。它不是进程。
- **Agent**：稳定身份，绑定一个 canonical Workspace 和一个 adapter。名称、短指引和 Skill 引用属于 Agent。
- **Membership**：Agent 加入 Team 的关系；包含岗位、职责和上级，不复制 Agent。
- **Team**：成员关系、唯一 Leader、创建根目录和团队任务的边界。
- **Task**：一个团队目标，只有一个负责人；可有 `parentTaskId`，用于多层任务链。
- **Session**：某 Agent 的一段对话，带 `teamId?` 和 Runtime Session ID。Team Session 与独立 Session 的归属不能被静默改写。
- **Run**：一次执行尝试。Run 状态与 Task 状态分离，进程退出不能直接等价为交付完成。
- **Report/Artifact/Note**：交付证据、发布文件和最小沟通记录。
- **Worker/Runtime**：执行宿主。一个共享宿主可以承载多个隔离 Session；它不是 Team 注册表，也不是 Agent 身份。

## 3. 目标架构和依赖方向

```text
CLI / Desktop / Web（未来 surface）
              │ 统一 client + subscription API
              ▼
agent-management（TypeScript 独立控制面）
  鉴权、注册、组织、任务、调度、锁、状态投影、持久化
       ├── Rind Adapter
       ├── Codex Adapter（未来）
       └── Claude Code Adapter（未来）
              │
              ▼
rind-runtime-client / Rind Runtime Worker
```

依赖规则：

- `agent-management` 不依赖 CLI UI。
- CLI 只通过 `agent-management/src/client.ts` 的请求/订阅契约通信，不直接读状态文件。
- Adapter 只负责启动/恢复执行并翻译事件；服务负责授权、队列、持久化和状态投影。
- `rind-runtime-client/` 是 CLI 和 Adapter 共用的无 UI transport/host 能力；不得导入 Team 模型，避免循环依赖。
- Python Runtime 只接收通用、可选、会话绑定的外部工具配置；不得导入 Team/Manager 数据模型。
- 共享状态必须通过显式接口传入；不增加全局可变 registry 或隐藏副作用。

## 4. 数据模型和不变量

实际类型定义见 [`agent-management/src/model.ts`](../agent-management/src/model.ts)。

```text
Agent       id, name, canonicalWorkspace, adapter, hint?, skillRefs?
Team        id, name, leaderAgentId?, createRoot
Membership  teamId, agentId, reportsToAgentId?, position?, responsibility?
Task        id, teamId, assigneeAgentId, createdBy, brief, status, parentTaskId?, blockedOn?, report?
Session     id, agentId, teamId?, runtimeSessionId, origin, shared?
Run         id, sessionId, taskId?, status, startedAt, lastObservedAt, hostSequence
```

必须保持：

- `(canonicalWorkspace, adapter)` 唯一；路径注册时 realpath，Windows 大小写不敏感，符号链接不能绕过检查。
- `(teamId, agentId)` 唯一；Leader 必须是成员；一个 Team 只有一个 Leader。
- `reportsToAgentId` 必须指向同 Team 成员，不能指向自己，不能形成环；没有上级的非根成员默认直属 Leader。
- 负责人必须是当前 Team 成员；已删除成员的未完成 Task 转为 `needs_attention`，不能继续启动。
- blocker 必须包含 `responder` 和具体 `action`；responder 只能是 `user` 或合法 Team 成员。
- Workspace 运行锁按规范化目录，而不是 Agent/Team ID；同目录写入运行串行，独立 worktree 可以并行。
- Team Session 必须保持 `teamId + agentId` 归属；不能通过打开另一个 Team 或 Workspace 静默复用历史。
- `done` 需要有效 Report 且 Adapter 确认执行完成；Run 结束本身不等于 Task 完成。

Task 状态：`queued → running → done | blocked | needs_attention | cancelled`。

Run 状态：`starting | running | succeeded | failed | cancelled | unknown`。

## 5. 权限和共享 Workspace

服务端根据连接凭据绑定 Principal 授权，不相信请求字段或模型提示词声称的身份。Principal 类型为 `user`、`manager`、`agent(sessionId)`。

| 能力 | User | Manager | Team Leader | 普通成员 |
| --- | --- | --- | --- | --- |
| 查看 Team/成员/任务/状态摘要 | 全局 | 全局 | 本 Team | 本 Team 必要摘要 |
| 创建 Team、注册目录、指定 Leader | 可 | 可代办 | 可在本 Team 添加 | 不可 |
| 在 `createRoot` 创建 Workspace/worktree | 可 | 可 | 可 | 不可 |
| 派任务、启动/停止协作运行 | 可 | 可 | 本 Team | 不可 |
| 更新自己的 Task、提交 Report | 可 | 可 | 本 Team | 自己的 Task |
| 读取成员私有文件和原始对话 | 原有 OS 权限 | 默认不可 | 默认不可 | 仅自身 Workspace |

Workspace 已属于另一 Team 时，交互入口必须先显示归属并让用户选择：

1. 建立独立副本（推荐；Git 项目优先 worktree/branch）。
2. 明确共享原 Workspace。

共享不会合并 Team、Task、Session 或交付物；只共享文件目录，运行仍按 Workspace 串行。Manager/Leader 不能替用户默许共享。

## 6. 调度、沟通和交付

- `assignTask` 只派给当前 Team 已注册成员；服务提交时和启动时都重新校验成员关系。
- Leader 只能直接协调自己的下属；服务根据汇报树限制任务可见性和操作范围。
- 子任务完成后通过 Report 逐级唤醒父任务；等待孙任务时中间 Task 不能提前标记完成。
- 同 Workspace 任务按锁排队；高/普通/低优先级只影响等待队列，不打断正在执行的 Run。
- `unknown` 表示宿主/桥接无法确认执行事实。不得自动重试可能已经写入文件的工作；必须由人确认旧进程已停止，再 Resolve/Retry。
- 交付最小结构：`outcome`、`summary`、`evidence[]`、`artifacts[]`、`nextAction?`。界面默认展示一屏摘要，原始日志和证据按需展开。
- Manager 看跨 Team 摘要、异常和待用户决策，不接收成员完整私有对话。
- 任务 Notes、Reports 和发布 Artifact 是沟通总线，不新增第二套聊天总线。

## 7. Runtime 和 Session 宿主

共享宿主位于 `RIND_HOME/runtime`，服务数据位于 `RIND_HOME/agents-management`：

```text
<RIND_HOME>/agents-management/
  manager/          Manager 专属 Workspace
  state/            token、endpoint、JSONL journal、snapshot、artifacts
  workspaces/       默认 Team 创建根目录
<RIND_HOME>/runtime/ 共享 Runtime host
<RIND_HOME>/sessions/普通/共享 Session 历史
```

共享 Worker 的正确模型是“共享无状态基础设施，隔离有状态 Session”：

- 一个宿主承载多个 Session；每个 Session 有独立 Workspace、历史、工具授权、问题状态、取消状态和单活跃 prompt 约束。
- 共享的是 provider/parser/transport 等无状态或只读资源，不共享会话可变状态。
- 关闭一个 CLI 只是 detach，不停止后台 Run；再次打开同一 Session 不得产生重复执行。
- `session/open` 校验 Workspace 和作用域，并安装会话绑定的外部工具配置；普通 WebSocket 客户端不能注入配置。
- Runtime 重启后先标记不确定状态，再通过 replay/host reconciliation 校准；无法确认时保持 `Unconfirmed`。
- 未来 Codex/Claude Code 接入统一 Adapter 契约，不修改 Team 核心。

## 8. 当前 CLI 入口和实现行为

### 8.1 普通聊天

- 继续使用 TypeScript TUI、组件树、全缓冲 diff、节流重绘、硬件光标 marker、Bracketed Paste 和 Kitty/modifyOtherKeys 兼容。
- 聊天输入为空时按左方向键进入 Agents Management；输入非空时左键仍是编辑行为。
- 不增加 `/manager`、`/agents` 等管理 slash command。Manager 是 Agents 页面中的导航项。
- 普通 Rind、Team 成员会话、Manager 会话均以普通 Rind 对话形式打开；状态栏显示管理上下文。

### 8.2 Agents 页面当前布局

当前 `frontend-cli/lib/agents-page.js` + `agents-view.js` 已实现：

- 独立全屏页面；默认启用 alternate screen，退出时恢复原终端。
- 左侧导航：Global Overview、Manager、Create Team、各 Team。
- Team 内三类视图：Overview、Organization、Tasks。
- Organization 使用 `reportsToAgentId` 展示缩进层级，可折叠分支。
- Team briefing 位于 Team Overview；Task 详情、Delivery、Notes、Artifacts 和执行历史可展开。
- 进入成员后可列出历史 Session 与实时 Session；选中 Session 可以在该成员 Workspace 恢复或加入。
- 表单、选择器、确认框复用已有 line editor / choice state；失败操作保留输入内容。
- 已有搜索 `/`、状态过滤 `F`、新建 Team `N`、刷新 `R`、Space 操作菜单。
- 当前最近实现启用了鼠标解析、点击、右键菜单和滚轮；这属于当前代码事实，不代表所有未来 UI 选择已经最终确定。
- 当前最近实现增加 `j/k`、`g/G`、`Ctrl-U/Ctrl-D` 和 `1/2/3` 导航，同时保留方向键、Tab、Enter、Esc。

### 8.3 当前 Session 展示语义的注意事项

当前成员 Session 列表会把管理服务返回的历史和 live Session 合并，按状态排序：`Needs input`、`Unconfirmed`、`Working`、`Ready`、`Inactive`。

但当前全局 `overviewRows()` 使用 `sessionRows(snapshot, null, ...)`，因此 `teamId` 为空的独立 Session 仍可能出现在 Global Overview 中；这是现有实现的真实行为，不要误认为已经完成“只展示 Team Session”的产品约束。Team 详情页和成员 Session 入口按成员/Team 关系工作。若产品最终要求全局也只显示 Team 关联 Session，应在 `frontend-cli/lib/agents-sessions.js` 和相应服务 snapshot 过滤处统一修改，并补测试，不能只在渲染层隐藏。

### 8.4 当前 UI 的产品状态

Agents 页已经从简单文本列表升级为可用 TUI，但它仍是“可验证的实现基线”，不是最终视觉规格。后续若重新打磨信息架构，应先确定：Team 是否为唯一一级入口、成员下如何嵌套 Session、全局 Overview 是否保留、鼠标是否保留、按钮/快捷键如何集中显示，再改布局和命中逻辑。不要在没有信息架构决策时继续增加零散快捷键或装饰色。

## 9. 代码地图

### 9.1 控制面

- `agent-management/src/model.ts`：共享类型、状态、校验和 Adapter 契约。
- `agent-management/src/organization.ts`：直属上级、子树、无环校验和 Leader 相关组织逻辑。
- `agent-management/src/projection.ts`：成员/Session 状态、队列原因、Team briefing。
- `agent-management/src/service.ts`：权限、注册、Team/成员、Workspace/worktree、Task、Run、Session、调度和恢复，是唯一业务写入边界。
- `agent-management/src/store.ts`：单写入 JSONL journal、snapshot、序列号和崩溃恢复。
- `agent-management/src/ipc.ts`、`server.ts`、`client.ts`：本地服务启动、认证、请求、订阅和断线处理。
- `agent-management/src/adapters/rind.ts`：Rind Runtime Adapter。
- `agent-management/src/bridge.ts`、`legacy.ts`：Runtime/旧 Team 只读导入桥。
- `agent-management/src/paths.ts`：RIND_HOME、Manager、state、workspaces、artifact 路径和 canonical directory。

### 9.2 Runtime

- `rind-runtime-client/runtime-client.js`：通用 Runtime transport。
- `rind-runtime-client/shared-runtime.js`、`shared-server.js`：共享本地宿主和生命周期。
- `rind-runtime-client/runtime-protocol.js`：Runtime 请求/事件协议。
- `frontend-cli/lib/runtime-client.js`：CLI 侧 Runtime 连接。

### 9.3 CLI 管理页

- `frontend-cli/lib/agents-client.js`：管理客户端和状态读取。
- `frontend-cli/lib/agents-commands.js`：Manager/成员会话打开以及非 TTY `rind agents` 命令。
- `frontend-cli/lib/agents-session.js`：管理作用域参数、服务准备和 Runtime 观察。
- `frontend-cli/lib/agents-sessions.js`：Session 行和 Global Overview 投影。
- `frontend-cli/lib/agents-page.js`：页面状态机、键盘/鼠标输入、表单、动作和服务请求。
- `frontend-cli/lib/agents-view.js`：布局、层级列表、详情、对话框、状态颜色和命中测试。
- `frontend-cli/lib/tui/tui.js`：终端模式、全屏、鼠标模式、增量渲染、同步输出和光标。
- `frontend-cli/lib/terminal-key.js`：普通键、Kitty、CSI、SGR/传统鼠标解析。
- `frontend-cli/lib/theme.js`：语义主题、背景面板和选中状态。
- `frontend-cli/lib/choice-menu-state.js`：选择器状态，支持键盘和按索引选择。

## 10. 已完成的功能面

控制面和 Runtime 已经具备：

- 任意现有目录注册为 Agent/Team 成员。
- Team Leader 和多级汇报树；服务端拒绝环和越权调度。
- Team 创建根目录下创建 Workspace 或 Git worktree。
- Workspace 重复归属检测，副本/共享明确选择。
- Task 分派、优先级、启动/重试、取消、阻塞、回答、Report、Note、Artifact。
- 单 Workspace 锁、不同 worktree 并行、未知 Run 保留和人工恢复。
- Team briefing、成员状态、Session/Run 状态投影和订阅。
- Manager 独立 Workspace、受限 Manager 工具和页内入口。
- 管理服务 JSONL 持久化、原子 snapshot、幂等 request、断线重连和恢复。
- 旧 `.aiteam` 只读预览/导入，不修改旧文件。
- 多 CLI/后台任务共享 Runtime；Session 历史和实时状态可恢复。
- 非 TTY `--json` 与 `rind agents` 命令路径使用同一管理服务。

## 11. 尚未完成或需要后续 session 决策的事项

按优先级：

1. **确定并冻结最终信息架构。** 重点是 Team → 成员 → Session 的嵌套方式、Global Overview 的保留价值、Team briefing 的位置、状态/动作/帮助的固定区域。当前页面能工作，但仍有较多布局和交互细节待产品化。
2. **统一 Session 过滤语义。** 明确是否任何全局页面都排除 `teamId` 为空的独立 Session；若是，服务投影和 `overviewRows` 必须一起修，保证 CLI、JSON 和未来 surface 一致。
3. **决定鼠标是否长期保留。** 当前代码已经支持鼠标；如果产品最终不要鼠标，需要同时移除 Agents 页的 `mouse: true`、鼠标输入分支、命中测试和鼠标测试，不能只隐藏提示文字。
4. **继续完善 Team 树视图。** 需要让 Leader、直属上级、职责、成员状态、Session 状态和 Task 状态在一屏内有稳定的视觉层级；避免把列表、详情、操作菜单互相嵌套成难读的卡片。
5. **完成 Manager 的可观测调度体验。** Manager 当前能打开受控会话，但跨 Team 摘要、从建议跳到 Team/Task、待用户确认和一页式交付仍可继续增强。
6. **增加 Codex/Claude Code adapters。** 复用 Adapter 接口和统一事件，不复制 Team 逻辑。
7. **补齐真实终端 QA。** 继续使用 `@xterm/headless` 做确定性测试，并在 Windows Terminal、常见 ANSI/Kitty 终端、窄窗口、CJK/emoji、断线恢复场景手测。
8. **最终清理和发行验证。** 检查旧 Python Team 可写入口、旧 `delegate` 注入和重复逻辑只保留迁移所需的只读桥；运行 staging 和干净 `RIND_HOME` 端到端流程。

## 12. 验证基线

在 PowerShell 中建议：

```powershell
$env:NO_COLOR = $null
npm --prefix frontend-cli test
npm --prefix agent-management test
```

当前基线结果：

- `frontend-cli`：505 tests，504 pass，1 skipped，0 fail。
- `agent-management`：25 tests，25 pass，0 fail。
- 相关 `node --check` 已通过。
- 主题测试需要清除继承的 `NO_COLOR`；有 `NO_COLOR` 时颜色断言失败是环境预期，不是业务逻辑失败。

重点测试文件：

- `frontend-cli/test/agents-page.test.js`：真实页面进入/返回、管理动作、成员/Session、Manager、草稿保留。
- `frontend-cli/test/agents-view.test.js`：布局、组织树、详情、选择器、宽度和命中测试。
- `frontend-cli/test/terminal-key.test.js`：键盘、Kitty、SGR/传统鼠标。
- `frontend-cli/test/tui-engine.test.js`：全屏、鼠标模式、恢复、diff、光标和重绘。
- `frontend-cli/test/tui-integration.test.js`：完整 CLI TUI/Runtime 交互。
- `agent-management/test/*.test.js`：权限、组织树、任务调度、共享 Workspace、恢复、报告和 Session scope。

## 13. 新 session 启动顺序

1. `git status --short --branch`，确认没有覆盖用户改动。
2. 阅读本文、`.docs/team-agents-management-design.md`、`docs/agents-management.md` 和 `docs/cli-rendering.md`。
3. 阅读 `agent-management/src/model.ts`、`organization.ts`、`projection.ts`、`service.ts`。
4. 阅读 `frontend-cli/lib/agents-page.js`、`agents-view.js`、`agents-sessions.js` 和相关测试。
5. 先运行两个测试套件，建立当前基线。
6. 若要改 UI，先写/更新渲染和交互测试，再改布局或状态转换；不要先引入新的 TUI 框架。
7. 若要改变 Session 归属或权限，必须同时修改服务投影、CLI 投影、非 TTY JSON 和测试。
8. 每次完成一组可审阅变化后提交 Git，并在最终回复中说明提交、测试和剩余风险。

## 14. 实现原则

- 轻量优先：Node 标准库和现有 TUI 足够时不引入框架。
- 边界清晰：UI、管理服务、Adapter、Runtime 各自只通过显式接口通信。
- 单向依赖：出现环形依赖就下沉公共抽象。
- 无冗余字段、无未使用分支、无“以防万一”的实体。
- 状态可观测但不过度广播：持久化低频事实，不复制每个 token 或全部私聊。
- 服务端是权限和状态真相；提示词、颜色、页面显示都不是权限边界。
- 失败必须可恢复、可解释；不确定运行不能伪装成完成，也不能盲目重试。
- 用户体验优先：所有动作都有清晰入口、当前焦点、状态反馈、取消路径和返回路径。

