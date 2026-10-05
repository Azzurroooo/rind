# Team Agents Management：设计大纲

> 状态：实施规格。后续修订已增加单根组织树、Session 级监视和共享 Runtime；最新行为与边界见 `docs/agents-management.md`。入口已按后续产品要求修订：空输入按 ← 打开管理页，Manager 从页内进入，不新增管理 slash command。实现与验证现状见 `docs/agents-management.md`。参考仓库为 Rind、Orca、Paperclip、Codex 和 Crush。

## 1. 产品定义与取舍

**一句话：** Agents Management 是独立于 Rind Worker 的本地控制面；它管理持久的 Agent 身份、任意目录组成的 Team、任务、运行与交付。Rind 是首个执行适配器，未来的 Codex、Claude Code 使用同一适配器契约。

- **Workspace 不是进程，也不必等同于 Agent。** Workspace 承载文件、记忆和项目级 Skill；Agent 是「稳定身份 + Workspace + 执行适配器 + 可选简短指引/Skill 引用」；Worker/Run 是一次临时执行。首版同一个规范化目录和适配器只注册一个 Agent，多个 Team 可以引用它。复制目录或创建 worktree 会得到另一个 Agent。
- **Skill 与 Workspace 互补。** Skill 固化可复用能力；Workspace 保存岗位或项目的持续状态、私有材料和产物。新成员无需生成 Capsule、清单或特定目录布局，也无需先创建 Team。
- **Team 是注册关系，不是父目录。** 任意现有目录均可加入。Team 通常有一位 Leader（主 Agent），其余岗位名称与职责由用户填写；Team 可以先建立再指定 Leader，但没有 Leader 时不能启动协作任务。
- **Manager 是独立入口的受控 Agent。** 它能查看所有 Team 的注册信息、任务与可信运行状态，协助组装和启动 Team；默认不能读取成员 Workspace 的私有文件或原始对话。全局可观测不等于全局文件权限。
- **跨 Agent 协作以可追踪的任务为协议。** 不以旧 `delegate` 作为新系统底座：它是同一 Python Worker 内、依赖旧 Team 目录的同步工具，不能自然覆盖独立 Rind/Codex/Claude 进程。旧 `delegate` 只在迁移期处理旧 Team；新 Team 使用 `assignTask`、任务更新、回执和交付。

首版不做远程多机控制、企业多租户、预算系统、自动复杂任务 DAG、跨 Team 自动共享私有文件，亦不假装能观测没有接入本控制面的外部 CLI 进程。这些不是加入简单 Team 的前置条件。

## 2. 架构与代码边界

```text
CLI / 未来 Desktop、Web
        │ 统一客户端 API；展示与交互
        ▼
agent-management（独立 TypeScript 包）
  本地服务：鉴权、注册、调度、状态投影、事件订阅、持久化
        ├── Rind Adapter ── Rind Runtime Protocol ── 独立 Worker
        ├── 后续 Codex Adapter
        └── 后续 Claude Code Adapter
        ▲
        │ 直接打开成员时，CLI 的轻量事件桥接
Manager / Leader Rind ── 通用外部工具桥 ── 本地服务
```

建议目录与依赖方向：

| 位置 | 职责 |
| --- | --- |
| `agent-management/src/{model,service,store,ipc}.ts` | 唯一的 Team/Agent/Task 规则、单写入服务、订阅与持久化；不依赖任何 UI。 |
| `agent-management/src/adapters/rind.ts` | 启动/恢复 Rind Worker、将 Runtime 事件归一化；不导入 CLI 页面。 |
| `agent-management/src/client.ts` | CLI 和未来 surface 共用的请求/订阅 API；本地连接失败给出明确状态。 |
| `rind-runtime-client/` | 从现有 `frontend-cli/lib/runtime-client.js`、`runtime-protocol.js` 抽出无 UI 的传输代码；CLI 与 Rind Adapter 共用，避免复制协议实现或形成循环依赖。 |
| `frontend-cli/lib/agents-*.js` | Agents 管理页面、表单/选择器、直接会话事件桥；只调用管理客户端。 |
| Rind Python Runtime | 只增加**通用的可选外部工具桥**与受信启动配置；不导入 Team/Manager 数据模型。未接入时仍是普通 Rind。 |

`agent-management` 使用 TypeScript 编译为 Node 18 可运行的 ESM JavaScript；运行时优先 Node 标准库，不依赖实验性 `node:sqlite` 或原生编译模块。CLI 包与发行包显式包含编译产物。`RIND_HOME` 的既有规则继续生效（默认 `~/.rind`）；服务数据置于 `<RIND_HOME>/agents-management/state/`，Manager 工作目录独立置于 `<RIND_HOME>/agents-management/manager/`，避免把状态库和凭据暴露给 Manager 的文件工具。

本地服务按需启动，单实例持有写入权；多个 CLI 只连接它，不各自写文件。Windows 用命名管道，Unix 用用户目录下 socket；连接凭据存放于仅当前 OS 用户可读的位置。安全边界是本机当前用户，不声称防御已获同一 OS 用户权限的恶意进程。

## 3. 最小数据模型和不变量

| 记录 | 必要字段 | 约束 |
| --- | --- | --- |
| Agent | `id, name, canonicalWorkspace, adapter, hint?, skillRefs?` | `(canonicalWorkspace, adapter)` 唯一；不要求 Workspace 内有管理文件。`hint` 可以是一句话，Skill 引用由适配器按运行时规则解析。 |
| Team | `id, name, leaderAgentId?, createRoot` | Leader 必须是本 Team 成员；`createRoot` 默认 `<RIND_HOME>/agents-management/workspaces/<team-id>`，可由用户更改。 |
| Membership | `teamId, agentId, position?, responsibility?` | 以 `(teamId, agentId)` 唯一；同 Agent 可跨 Team，但不得在同 Team 重复添加。岗位名称不产生权限，Leader 权限仅由 Team 的 `leaderAgentId` 决定。 |
| Task | `id, teamId, assigneeAgentId, createdBy, brief, status, blockedOn?, report?` | 一个任务一个负责人；负责人必须仍在该 Team。`blockedOn` 明确 `responder` 与 `action`；`report` 保存简短结果和交付引用。 |
| Session | `id, agentId, teamId?, runtimeSessionId, origin` | Team 会话与独立会话分开；共享 Workspace 时不共用跨 Team 对话。`origin` 为 managed/direct。 |
| Run | `id, sessionId, taskId?, status, startedAt, lastObservedAt` | 一次执行尝试；直接聊天没有 `taskId`。Run 与 Task 状态分开，避免把进程退出误判为交付完成。 |

路径在注册时以真实路径规范化，Windows 还需做大小写无关比较；符号链接不能绕过重复检测。运行锁按**规范化 Workspace 路径**，而非 Agent/Team ID：同一目录被不同 Team 或不同适配器引用时，首版每次只允许一条写入型运行，后续任务排队。Worktree 有独立目录，故可以并行。

首版 Agent 配置只保存可选短指引与 Skill 引用，不复制 Skill 内容。运行指引显式组合为 Agent 指引、当前 Team 的 `responsibility`、当前任务；用户最新指令优先于旧任务文本。外部文本和其他 Agent 的回执始终是数据，不获得新权限。

## 4. 权限、共享与会话归属

管理服务依据**连接凭据绑定的主体**授权，而不是相信请求参数或系统提示词中的「我是 Leader」。由服务创建的运行凭据绑定 `agentId + teamId + sessionId`；Manager 有单独主体；用户 CLI 通过本机用户凭据操作。所有写请求在提交时重新检查成员关系、Leader 身份及 Workspace 创建边界。

| 操作 | 用户 | Manager | Team Leader | 普通成员 |
| --- | --- | --- | --- | --- |
| 查看 Team/成员/任务/状态摘要 | 全局 | 全局 | 本 Team | 本人任务与本 Team 必要成员摘要 |
| 创建 Team、注册现有目录、指定 Leader | 可 | 可按用户任务代办 | 只可向本 Team 添加成员 | 不可 |
| 在 Team `createRoot` 下新建目录/worktree 并加入本 Team | 可 | 可 | 可 | 不可 |
| 给成员派任务、启动/停止 Team 协作运行 | 可 | 可 | 仅本 Team 已注册成员 | 不可 |
| 更新任务/提交回执 | 可 | 可 | 本 Team | 仅本人任务 |
| 读成员私有文件或原始对话 | 用户原有文件权限 | 默认不可 | 默认不可 | 仅自身运行时原有权限 |

Manager 的跨 Team 元数据权限不自动扩展为文件权限；Manager Rind 会话只注入管理工具，文件工具限制到其工作目录，**不提供 Shell 和任意文件读取工具**。Team 成员保留普通 Rind 的工作区能力，但调用 Team 协作接口必须经过注册核验；直接用 Shell 启动的任意外部进程不会被登记为 Team 成员，也不被显示为受管运行。若将来需要禁止 OS 层面的任意进程启动，必须另行引入进程沙箱，不能用提示词冒充强约束。

添加已属于其他 Team 的 Workspace 时，先显示其现有归属并提供两个明确选项：**建立独立副本（推荐）**、**共享原 Workspace**。Git 项目优先创建独立 worktree/branch；普通目录复制时预览目标与规模，不默认复制敏感文件。共享必须由用户明确选择；Manager/Leader 不能替用户默许共享。共享意味着该 Agent 可看见同一目录中的全部文件，但 Team 的任务、会话、回执和发布物仍分开；同目录运行串行化。

普通 `rind` 打开某目录：无注册则维持现有体验；只属于一个 Team 时自动附着并在状态栏说明；属于多个 Team 时，TTY 选择本次 Team 或「独立会话」，非 TTY 必须显式 `--team <id>` 或 `--standalone`。直接聊天产生 Session/Run 观测事件，但不自动变成某个 Task，也不把聊天内容广播给其他 Team。已注册目录若本地服务不可用，CLI 先尝试启动/重连；仍失败则明确报错并提供显式独立模式，不能静默声称已捕获状态。

## 5. 服务 API、适配器与运行规则

对外只有一套本地请求/订阅契约；CLI 页面、文本命令、Manager 工具均调用同一服务规则。初始操作集合：

- 查询：`listTeams`、`getTeam`、`listAgents`、`getTask`、`subscribe(afterSeq)`。
- 编排：`createTeam`、`registerAgent`、`addMember`、`setLeader`、`createWorkspace`、`createWorktree`。
- 执行：`assignTask`、`startTask`、`cancelRun`、`updateTask`、`publishArtifact`、`postTaskNote`。
- 直接会话桥：`attachSession`、`reportRunEvent`、`detachSession`。

请求示例（字段名同时作为实现契约的起点）：

```json
{"method":"assignTask","params":{"teamId":"product","assigneeAgentId":"finance","brief":"核对九月票据并给出差异摘要","requestId":"cli-42"}}
{"method":"reportRunEvent","params":{"sessionId":"s-1","runId":"r-1","hostSequence":18,"type":"needs_input"}}
{"method":"updateTask","params":{"taskId":"t-1","status":"blocked","blockedOn":{"responder":"user","action":"确认缺失发票的税号"}}}
```

`assignTask` 在单次提交中校验 Team 与受派成员关系、记录任务与通知意图；`startTask` 再次校验，故删除成员或切换 Leader 后旧任务不能越权启动。所有会改变状态的请求带幂等 `requestId`；服务对相同主体、方法和请求 ID 返回原结果，避免 CLI 重试造成重复任务或 worktree。对未注册成员返回明确的 `NOT_TEAM_MEMBER`，绝不启动进程。

适配器实现统一的 `start(input, emit) -> handle` 契约：输入包含 Workspace、当前 Team/任务、可恢复的 runtime session ID 与指引；`handle` 提供 `completion`、`cancel()` 与真实 runtime session ID；事件统一为 `starting / working / needs_input / idle / completed / failed / exited`，附来源序号。服务负责授权、队列、持久化和状态投影，适配器只负责执行与翻译。首版实现 Rind Adapter；Codex/Claude Code 以后接同一契约，不在 Team 规则里加 provider 分支。无法可靠提供某种事件的适配器必须上报 `unknown`，不能猜测为 `working`。

Rind Adapter 使用已有 `initialize`、`session/new`、`session/prompt`、`session/subscribe`、`session/replay`、`shutdown` 和 `session/update`。受管任务由服务启动并监督 Worker；用户直接打开的 CLI Worker 仍由 CLI 拥有，CLI 桥只发布经 Runtime 确认的开始/结束/需输入事实，并在断线后从 Runtime 快照校准。`session/replay` 是恢复会话状态的依据，不把流式 token 当管理事件，也不把会话游标误当 Run 事件游标。其他 surface 接入时实现同样的轻量桥，管理核心不变。

Rind 现无通用外部管理工具入口。实施时在 Worker 组合根注入一个可选、与业务无关的工具桥：仅当受信 CLI/服务启动配置提供本地端点及**会话绑定凭据**时，向容器传入 `agent_management` 工具规范；该工具将动作与参数转发给服务，并返回结构化成功/拒绝。未配置时不注册。Manager 会话由管理页内的 Manager 入口在专属工作目录启动，使用受限工具清单；Leader/成员的动作范围由服务端凭据决定，提示词只负责说明用法。旧 `delegate`、`agent_create` 不在新受管会话中暴露。适配器、CLI 和其他 surface 不直接读写管理状态文件。

任务状态为 `queued → running → done | blocked | needs_attention | cancelled`；解除 `blocked` 后回 `queued`，明确重试可由 `needs_attention` 回 `queued`。进入 `blocked` 必须给出回应者与具体解阻动作，并向回应者显示提醒；纯文本「被阻塞」无路由则拒绝。Run 独立记录 `starting / running / succeeded / failed / cancelled / unknown`。进程消失、桥断线或恢复后无法确认活性时，Run 变 `unknown`、任务变 `needs_attention`；不自动重试可能已写入文件的工作。只有适配器确认执行结束，且提交了有效回执，任务才能 `done`。

工作区/ worktree 创建由服务完成：先校验目标不存在、规范化后位于当前 Team 的 `createRoot`、Git 仓库与 branch/base ref 有效，再执行 `git worktree add` 或安全建目录；成功后注册 Agent 与 Membership。失败保留明确错误，不删除用户原有目录；清理仅限本次确证创建的空目标。删除 worktree 不属于首版快捷动作。复制与共享均需用户预览/确认；若 Manager 请求需要用户选择的动作，服务返回待确认摘要，CLI 以用户通道完成确认后**重新检查前置条件**，模型不能自批。

## 6. 观测、沟通与交付

执行宿主是活性事实来源；管理服务只保存带来源与时间的投影。服务持久化 Team/Agent/Task/Session/Run 的低频变化，不记录每个 token。单写入者先落盘再广播递增 `seq`；客户端用「快照 + `subscribe(afterSeq)`」恢复，落后或断线先重取快照。重启时仅从持久状态可恢复已知历史，所有无宿主确认的运行标为「状态待确认」，直到 CLI 重连或 Adapter 通过 Runtime 校准；不能把上次的 `working` 继续显示成实时运行。

任务更新与 `postTaskNote` 构成最小协作通道：每条任务有负责人、最新进展、阻塞路由及回执，Leader 收到成员结果和需处理事项，Manager 跨 Team 查看摘要与异常。不要把每段对话复制给所有人，也不要新增独立聊天总线。直接给成员发送的用户消息留在其原会话，只投影「在工作/需输入/最近活动」；跨 Team 泄露防护仍依赖显式发布。

任务回执要求简短、可核验：`outcome`、`summary`、`evidence`（如测试命令/结果、commit 或差异）、`artifacts`、`nextAction?`。服务检查明确列出的本地文件确实存在且位于该成员 Workspace；需要交给 Team 的文件通过 `publishArtifact` 显式复制到管理目录下该 Team/Task 的交付区，并记录名称/大小/摘要校验值。未发布的私有文件仅可作为给用户的本机路径提示，不自动开放给 Leader。界面默认展示一屏摘要与可打开的交付物，原始 Run 日志按需进入详情；Manager 总览优先显示「需人处理、进行中、空闲、状态待确认」。

持久化采用单写入 JSONL 事件日志作为事实来源、原子替换的快照加速启动；事件只含管理动作和低频状态，不含模型流。确认写入前刷新日志；恢复时校验序号，最多舍弃不完整尾记录，较早记录损坏则报错并保留现场，不静默清库。事件文件达到明确阈值后进行快照与安全轮换，并用断电/中断用例验证；不引入 SQLite 原生依赖。状态目录与交付区均限制为当前 OS 用户访问。

## 7. CLI 体验

- 空聊天输入时按 ← 打开专页；从普通会话进入时保留输入草稿和当前 Session。首页是所有 Team 的名称、Leader、成员数、运行/阻塞/待确认数；选中 Team 后看岗位、Workspace、任务与最新状态。搜索、状态筛选、打开成员、组装 Team、创建 worktree、派任务、进入 Manager 都在此完成。关键操作只显示「选择 Team → 选择目录/成员 → 确认职责/任务」；不要先要求用户理解 Capsule/Blueprint/注册清单。
- 页面中的 Manager 导航项打开受控 Manager 会话，不注册 `/manager` 或 `/agents` 命令。返回普通会话时不切换它的 Workspace 或历史。Manager 给出的全局建议可跳到具体 Team/Task，敏感选择在 UI 中确认。
- 非 TTY 提供对应文本命令，如 `rind agents list`、`rind agents team create <name>`、`rind agents team add <team> <path>`、`rind agents task <team> <agent> <brief>`、`rind agents open <team>/<agent>`，并提供 `--json` 供脚本使用。交互页与文本命令只调用同一服务；非 TTY 遇到共享目录等需用户选择的情况须报明确错误与选项，不偷偷选择。
- 独立打开已注册 Agent 时继续呈现普通 Rind 聊天界面，只在状态栏标出当前 Team/独立归属与运行状态。工作中、需输入、空闲、离线/未知使用不同文字，不能只靠颜色。所有页面宽度与终端模式沿用现有 CLI TUI 组件树。

## 8. 迁移、实施顺序与验收

**迁移旧 Team：** 先提供只读导入器：读取旧 `.aiteam/project.yaml` / Agent 清单，按真实目录注册 Team、Agent、Membership，并把旧主 Agent 映射为 Leader；原文件、工作目录和历史会话一律不删除。导入预览展示路径冲突、缺失目录和跨 Team 共享选择；确认后幂等导入。新受管会话显式跳过旧 `discover_agent` 自动发现，避免同时启用两套 Team 工具。新路径通过验收后清理 Python 中的旧 Team 创建、目录约束、`delegate`/`agent_create` 注入和 CLI 的旧 `/team` 流程；迁移入口可暂时保留为只读命令，不保留两套可写注册表。普通 Rind 文件/Skill/历史功能不受清理影响。

实施按下列可合并的阶段推进，每阶段有可验证结果：

1. **控制面基础：** 完成数据模型、单实例服务、IPC 客户端、持久化和授权。测试重复注册、跨 Team 共享显式选择、成员删除后的启动拒绝、重复请求幂等、两 CLI 并发写与崩溃恢复。
2. **执行接入：** 抽取共享 Rind Runtime 客户端；完成 Rind Adapter、服务拥有的任务运行、直接 CLI 会话桥、Workspace 运行锁和可选外部工具桥。测试普通 Rind 无插件不变、Leader 只能唤起当前 Team 成员、跨 Team 同目录串行、断线后显示未知而非运行中。
3. **CLI 与 Manager：** 实现空输入 ← 入口、页内 Manager、文本命令和一屏交付；检查草稿/会话保留、非 TTY 歧义错误、Manager 无法读私有文件、阻塞提醒可路由。
4. **迁移与清理：** 导入旧 Team，删除旧写路径与重复逻辑，更新文档和发行打包。对现有 CLI Node 测试、Python Runtime 测试以及 Windows 命名管道/路径/Git worktree 场景做回归；用干净的 `RIND_HOME` 走完端到端。

最终验收场景：用户从任意两个无清单目录组 Team，Leader 给已注册成员派任务并收到可核验摘要；试图派给未注册目录时**没有启动进程**；把同一财务 Workspace 加入第二 Team 时必须先选择复制或共享，选共享后直接打开时选择归属；同一仓库的两个 feature worktree 可并行工作；Manager 能概览所有 Team 的真实/未知状态但不能读取财务私有文件；进程异常退出后任务进入需处理状态，重启不会自动重复执行；旧 Team 能预览导入且原文件未被改动。

## 9. 参考源码与采用的原则

- Rind：`docs/architecture.md`、`agent/runtime/server/protocol.py`、`frontend-cli/lib/runtime-client.js`、`agent/infrastructure/team/delegation.py`、`agent/bootstrap/container.py`。据此确定协议、CLI/Worker 边界及旧 Team 的迁移切点。
- Orca：`E:\code\agent1\orca\docs\reference\agent-status-store.md`、`docs\reference\worktree-scan-fingerprint.md`、`src\main\worktree-removal-safety.ts`。采用执行宿主拥有活性事实、恢复状态不得伪装为实时、避免持续全量扫描和谨慎处理 worktree 路径的原则。
- Paperclip：`E:\code\agent1\paperclip\doc\SPEC-implementation.md`、`doc\execution-semantics.md`、`server\src\adapters\registry.ts`。采用任务单一负责人、组织/归属/执行分离、阻塞必须可路由、适配器统一契约与清晰交付；不照搬其公司、预算、审批和完整数据库体系。
- Codex：`E:\code\agent1\codex\codex-rs\tui\src\app\agents_overview.rs`、`agents_overview_view.rs`。借鉴总览分组、搜索、打开/创建入口与断线状态提示；Rind 的页面仍按自身 CLI 组件和产品目标实现。


## 后续实施修订：组织与会话宿主

- Membership 增加 `reportsToAgentId`；省略时非根成员直属 main-agent。服务端校验单根、无环、成员关系，成员只向直属下级委派，并可查看子树任务。用户/Manager 可调整组织。现有任务继续按原 `parentTaskId` 汇报，子树等待逐级传递。
- 管理页新增全局 Overview，Team 内为 Overview / Organization / Tasks。Team briefing 放在 Team Overview；组织树可折叠，成员下展示全部可见 Session，选定后在该成员 Workspace 进入原会话。
- `rind-runtime-client` 提供通用本地共享宿主；管理部件通过适配器接入，Python Runtime 不依赖 Team 模型。`session/open` 按 Session 注入外部工具与工作目录；执行容器、取消与用户问题均按 Session 隔离。
- 受管 CLI 和后台任务共享 Worker。关闭 CLI 仅断开连接；重入正在运行的 Session 不产生重复执行。管理重启后由宿主回放校验状态，宿主丢失则保留 Unconfirmed，禁止盲目重试。
