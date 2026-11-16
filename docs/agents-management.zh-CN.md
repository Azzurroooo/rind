# Agents 管理（Agents Management）

[English](agents-management.md) | 简体中文

Agents Management 是常驻执行体的本地控制平面。它是一个独立的 TypeScript 包；Rind 只是它的第一个执行适配器，未来的 Codex 或 Claude Code 适配器也将遵循同一套任务与运行契约。

## 启动

构建一次服务后，即可在仓库中使用 CLI：

```sh
npm --prefix agent-management install
npm --prefix agent-management test
npm --prefix frontend-cli install
npm --prefix frontend-cli run build
node frontend-cli/bin/rind.js agents list
```

服务会在 `RIND_HOME/agents-management` 下按需启动。其状态由原子写入的 JSONL 日志与快照组成。`manager/` 是 Manager 的私有工作区；`state/` 存放凭据、本地端点与已发布产物。请确保 `RIND_HOME` 仅当前用户可访问。

## 团队工作流

团队与任务由 Agents 页面（`rind agents`，或在空白聊天输入框按左方向键 `←`）或 Manager 管理。只有用户和 Manager 能创建任务，因此每个任务都有明确的交付接收方。命令行用于观测与故障恢复：

```sh
rind agents list --json                         # 输出完整状态，供脚本和诊断使用
rind agents stop <run>                          # 停止单次运行
rind agents resolve <run> --confirm-stopped     # 确认旧进程已停止后释放对应运行锁
rind agents stop [--all]                        # 停止后台服务
rind agents import <legacy-root> [--confirm]    # 导入旧版 .aiteam 团队
```

`rind agents` 拒绝在 Rind 会话内部执行，以防会话内的 shell 冒充用户身份。团队成员通过 `delegate` 和 `report` 协作，Manager 通过 `agent_management` 管理组织与任务。

每个成员都对应一个已存在的规范目录。团队是注册表关系，因此同一目录可以加入多个团队。如果某目录已属于其他团队，Agents 页面会推荐创建独立副本，并将共享作为显式选项提供。共享工作区会串行化写入；Git worktree（**Add member › New Git worktree**）则会注册为独立成员并可并行运行。

第一个成员不会被暗中赋予额外文件权限：它只是初始负责人（Leader）。每个团队都有一名主成员以及一棵汇报关系树。成员只能向自己的直接下属委派任务，并查看其子树中的任务；任何成员都可以在团队创建根目录下新建并注册自己的直接下属；用户和 Manager 可以调整整棵组织树。系统拒绝循环汇报关系，移除上级前必须先重新指定其直接下属。任务只有在提交有效报告且确认执行结束后才会进入 `done`。阻塞项（blocker）必须指明由 `user` 或当前成员处理，并说明所需动作。报告会逐层向上唤醒最初发起委派的任务；等待孙级任务不会提前完成中间层任务。调整成员汇报线不会改写已有任务的归属或父子关系。扁平团队依然有效：未指定上级时默认向团队负责人汇报。

目录基名作为初始成员名称，职位（position）是独立的展示标签。新工作区与 worktree 创建在团队的 `createRoot` 下：在 Desktop 中默认为当前打开项目的目录，否则为 `RIND_HOME/agents-management/workspaces/<team>`；Manager 也可以用已存在的其他目录（`createRoot`）创建团队。可通过 `registerAgent` 提供成员提示词与 Skill 引用（普通项目/用户 Skill 名称或 `SKILL.md` 绝对路径）；导入的旧版地方法规 Skill 会保留原始引用目录。

## CLI 界面

在聊天输入框为空时按 **左方向键（←）** 即可打开 Agents Management；退出方式见[返回、离开与停止](#返回离开与停止)。输入框非空时保持正常光标移动。管理面板不额外增加斜杠命令，命令行入口保持为 `rind agents`。整个页面纯键盘操作且从不捕获鼠标，因此终端原生选区复制与滚屏回看始终可用。

### 布局

```text
 Agents › Product › Organization                        ! 1 need you  ● 1 working  ● connected
  ! Inbox              1│Product · 4 members · leader Lead
  ◆ Manager             │ Organization   Tasks 1
  ◇ Independent         │
─ TEAMS · 1 ────────────│  + Add member                                   │ API
› ! Product          ! 1│  Lead          Leader                 ● working │ Backend · reports to Lead
  + New team            │  ├─ ● Plan the release          Working     now │
                        │  ├─ API        Backend            ! needs you   │ ! Needs you
                        │  │  ├─ ! Fix the login          Needs input  2m │
                        │  │  └─ DB      Database                   idle │ Workspace
                        │  └─ Web        Frontend               ○ 1 open │ ~/work/api
 ✓ Member added
 enter open member  space more actions  c new conversation  e edit role  t assign task  a add member below  ? help  esc back
```

- **顶栏（Header）** — 左侧为面包屑路径；右侧显示待处理项、活跃运行数与连接状态。
- **侧栏（Sidebar）** — 包含 Inbox、Manager、Independent、Background、各团队（显示最高优先级状态）与 New team。宽度低于 84 列时侧栏独立成屏：按 `Esc` 返回侧栏，按 `Enter` 进入所选页面。
- **主视图（Main view）** — 当前选中页面。团队包含 Organization 与 Tasks 两个视图（`Tab`、`1`、`2` 切换）。
- **详情栏（Detail pane）** — 展示当前选中行的详情及 `Enter` 动作；90 列及以上位于列表右侧，窄高终端位于列表下方。
- **状态行（Status line）** — 显示最近一次操作结果（✓、✕ 或 •），数秒后自动清除；操作执行中显示旋转指示器。
- **快捷键栏（Key bar）** — 仅展示对当前选中行生效的按键，按重要度排序，并按具体动作命名（如 `enter open member`、`enter join`、`enter open report`）。`?` 与 `esc` 始终保留，空间不足时整项隐藏而绝不截断。所有动作统一在 `frontend-cli/lib/agents-keys.js` 的单表中声明，保证底栏、`?` 帮助浮层与实际按键行为完全一致：未列出的按键不做任何动作，`Space` 也不会回退成 `Enter`。

### 组织树（Organization）

汇报树以团队负责人为根；未显式设置上级的成员直接向负责人汇报。成员行与会话行采用不同绘制样式以避免层级混淆：

- **成员行** — 粗体显示名称，对齐列显示角色，右侧以文字汇总该成员状态：`● working`、`! needs you`、`○ 1 open` 或暗色 `idle`；成员行自身不在树首放置状态符号。
- **会话行** — 缩进在所属成员下方的树形导引线内，带独立状态符号、状态名与相对时间：`├─ ● Plan the release   Working   now`。内联展示最紧急的 3 条会话，其余折叠为 `+N more`。

全界面共用同一套状态符号：`!` Needs input、`?` Unconfirmed、`●` Working、`↻` Running job、`⋯` Delegated、`◦` Queued、`○` Open、`✓` Done、`·` Idle。只有 `!` 需要你介入；按 `?` 可查看完整图例。成员摘要还会统计未结任务数（如 `○ 1 open · 2 tasks`）。

### 状态含义

共享 Runtime 托管所有交互式 Rind 窗口和团队任务的会话，并维护一张轻量实时表：记录每个会话的工作目录、是否有轮次正在运行或等待回答，以及当前有多少窗口正在屏幕展示该会话。该表由 Runtime 已处理的请求与事件直接驱动，无需轮询，并在状态突发变化时合并推送给 Agents 页面。

| 状态 | 含义 |
| --- | --- |
| `●` Working | 轮次或任务正在运行（无论是否有窗口正在显示）。 |
| `↻` Running job | 当前轮次已结束，但由它启动的后台作业（如构建、测试）仍在运行；作业结束后会自动唤醒继续执行。列表会标出作业命令（如 `↻ Running job · npm test +1`），详情栏显示完整信息，无需人工介入。 |
| `⋯` Delegated | 任务已将子工作委派给下属成员，待所有子工作交付后会自动携结果恢复运行，无需人工介入。 |
| `!` Needs input | 会话停下向你提问，或任务阻塞在需要你回答的问题上。 |
| `?` Unconfirmed | 服务中断后无法确认某次运行的最终结果；请先确认旧进程已退出再决定重试。 |
| `○` Open | 当前没有运行中的工作，但正被至少一个 Rind 窗口展示在屏幕上（可多终端同时打开）。 |
| `·` Idle | 无运行工作且无窗口展示；时间表示最近一次活动。 |

Open 仅代表正在屏幕上显示。被 Agents 页面遮盖的窗口仍持有原会话，但会通过 `runtime/visibility` 告知 Runtime，因此该会话会显示为 Idle（若轮次运行中则仍为 Working）。关闭或切换窗口绝不会中断正在运行的轮次。会话只有在发送第一条消息后才真正创建：在此之前窗口只是一个目录加输入框，没有会话 ID（顶栏显示 `session new`），Runtime、管理服务与 Agents 页面中都不会留存空记录。`/model`、`/effort` 与 `/login` 修改当前窗口设置并在创建会话时生效；`/sessions` 与 `/status` 可直接使用；`/goal`、`/compact`、`/context` 与 `/fork` 会提示需先开始会话。发送首条消息时执行 `session/create` 并落盘，自此出现在各列表中。若首条提示词在保存前失败（例如缺少密钥），空会话会被丢弃（`session_discarded`），窗口回到新建态；重试时复用同一管理绑定。在首条消息前离开窗口不会留下任何痕迹，按 `esc` 返回仍回到原位置的新建会话。`rind run` 与团队任务采用完全一致的创建流程。

### 会话命名与删除

会话优先显示自定义名称，否则显示首条消息（最多 80 字符，各列表按列宽裁剪），再否则显示会话 ID。`/rename <name>` 设置名称，无参 `/rename` 查看当前显示名而不做修改，`/rename --reset` 恢复使用首条消息。名称按原样单行保存（支持单引号等字符，上限 80 字符）。首条消息发出前也可预设名称并在创建时带入。在 Agents 页面对会话按 `Space` 选择 **Rename…**（留空即重置），底层调用同一会话命令（在消息同一把锁下执行 `rename`），确保只有单一写入路径。重命名会广播 `session_renamed`：其他打开该会话的窗口实时同步，共享 Runtime 的实时表也会在重读历史前即时更新所有列表标题。分叉（fork）会话不会直接复制源名称，而是显示源标题加 `(fork)`。`Space` 菜单同时提供 **Delete conversation…**：确认后永久删除已保存的消息；会话运行中或正被窗口展示时拒绝删除，删除后同步清理管理注册信息，`Esc` 也不会再返回已删除会话。

### 多窗口协同观察同一会话

任意数量的 Rind 窗口都可以同时打开同一个会话，由共享 Runtime 保持同步：

- 当模型发起提问时，所有打开该会话的窗口都会展示问题卡片；任一窗口作答后，其余窗口自动收起并标注“已在其他窗口回答”。
- `rind send --session <id> "…"` 会发送到最近展示该会话的窗口；若当前无打开窗口但轮次仍在运行，则作为 follow-up 入队；若会话处于空闲且无窗口打开，则拒绝裸启动，避免丢失原窗口配置的工具与管理作用域。
- Background、Independent 与各团队页面都按统一的“会话 ID + 目录（或团队成员 / Manager）”方式打开会话；目录优先取自 Runtime 实时表，因此尚未落盘历史的活跃会话同样可以切入；若无法启动窗口，Agents 页面会直接给出原因。

**左方向键 `←` 始终向上退一级**（从会话退到成员，从成员退到侧栏）且绝不折叠节点，最多按两次即可退回侧栏；右方向键 `→` 展开折叠成员或进入成员页。`z` 折叠/展开当前分支，`Z` 全部折叠/展开；折叠成员会显示 `▸`、隐藏行数以及内部最紧急状态。滚动列表时上下保留两行上下文。`/` 搜索、`f` 按状态过滤，匹配节点自动保留祖先链，`Esc` 清除过滤。

团队页面仅列出绑定到该团队的会话（由服务端 `listSessions { teamId }` 强约束）；同一目录的普通会话归入 Independent 页面。

在成员行按 `Enter` 打开该成员页：顶部为 **New conversation**，下方按紧急度与时间列出其在本团队的所有会话；在会话行按 `Enter` 则进入该成员工作区接入对话。常用单键直接作用于当前成员：`c` 新建会话、`t` 分配任务、`a` 在其下新增成员、`e` 编辑角色与职责、`Space` 打开全部操作（调整上级、确认未知运行、移出团队）。团队负责人的变更由 Manager 执行。

### 任务（Tasks）

任务按“最先需要你做什么”分为六组：Needs you、In progress、Queued、Delegated to members、Delivered 与 Cancelled。每行展示负责人与优先级；宽终端还会显示阻塞说明、排队原因或交付摘要。优先级只调整排队顺序，绝不打断正在运行的任务。

按 `Enter` 打开任务的**交付报告（report）**：

```text
 Ship the login page
 ✓ Done · Product › Web · delivered 12m ago · high priority

 New delivery · a accept · b send back for rework

 Outcome   completed
 Summary   Replaced the login form and added rate limiting; the old
           endpoint now redirects.
 Evidence  • unit tests pass
           • screenshot of the new page
 Files     login.png  12.4 KiB  ~/.rind/agents/artifacts/…/login.png
 Next      Announce it in the release notes

 ▸ Notes 3 · Runs 1   z to show
 a accept  b send back  n add note  o open files  z history  space more actions  r refresh  esc back
```

报告头部展示当前状态，下一行指出需要你拍板的事项（回答阻塞、处理异常或验收新交付），随后是对齐排版的交付详情，备注、运行记录与子任务默认折叠（按 `z` 展开）。底栏提供对应操作：

- `a` **accept（验收通过）** — 标记交付已审阅，Inbox 不再将其标为新交付。
- `b` **send back for rework（打回返工）** — 询问修改意见后，向原负责人派发附带反馈与原报告的新任务（`reworkOf`）；原报告保留并注明已打回（仅当原负责人仍在团队中时提供）。
- `n` 添加备注（若任务正在等待你回答，则直接作为答复并恢复运行）；`o` 原地查看已发布产物或打开负责人的会话；`Space` 打开更多任务操作（启动/重试、调整队列优先级、停止/取消、确认未知运行已停止）；`r` 刷新。

### 删除团队

在侧栏选中团队按 `Space` 选择 **Delete team…**，输入完整团队名称确认；对话框会先说明将释放多少成员、移除多少任务。团队存在运行中任务时拒绝删除，请先停止或确认结束。删除后团队及其任务与发布产物被移除，原成员的团队会话转为各自目录下的普通会话（正在窗口中打开的会话继续正常工作），工作区目录、源码文件与会话历史完好无损。若被释放的目录不属于其他团队且没有自定义提示词或 Skill，则自动取消 Agent 注册；带有专属提示词的目录则保留配置。

### Manager 权限与审批

Manager 可直接组建团队、指派工作、移除成员或删除完全空白的团队（无成员、任务或会话）。任何会清除历史或中断运行中工作的操作——例如删除非空团队、停止正在运行的任务——都会转为 **Inbox** 中的审批请求（如“Approve: Delete team Product”），默认预选 Decline（拒绝）。在你拍板前不会发生任何变更；若审批目标在此期间已自行结束或消失，审批项会自动从 Inbox 移除。

### Inbox、Manager 与 Independent

**Inbox** 汇总跨团队所有等待你处理的事项：Manager 审批请求、阻塞在用户上的任务、需关注任务、停止状态待确认的运行、停下提问的任务以及等待回答的团队会话；按 `Enter` 直接审批、作答、确认或接入。下方 **Recently delivered** 列出由你或 Manager 指派且尚未审阅的新交付（粗体 `●` 标记）以及最近审阅过的交付（返工标记 `↺`），按 `Enter` 打开报告。

**Manager** 页面列出 Manager 会话并在其专属目录中发起新对话。该目录即 Manager 的身份标识：直接在该目录启动 Rind（或通过 `--cwd`/`--dir` 指向它）会打开完全相同的 Manager 窗口、会话与 `agent_management` 工具作用域。

**Independent** 实时按目录分组展示所有不属于任何团队的独立会话。团队外的会话只是普通会话，不会自动注册为 Agent。运行中与已打开的目录排在最前；每个目录展示最紧急的 3 条会话及 `+N more`，按 `Enter` 进入目录专页（按 Active、Today、This week、Earlier 分组，支持 `/` 搜索）。`[` / `]` 在目录间跳转，`z` / `Z` 折叠，`c` 在选中目录新建会话。概览页仅通过一次 `listSessions { independent: true }` 调用完成聚合（按会话 ID 排除团队会话、按路径排除 Manager 目录），展示期间每 30 秒刷新历史并实时接收运行态推送。

### 添加成员

**Add member** 支持三种来源，都会标明新成员的汇报上级（团队首名成员自动成为负责人）：

- **Existing folder（已有目录）** — 支持绝对路径、`~/…` 或相对路径，输入时实时列出匹配目录：`Tab` 补全、`↑↓` 与 `Enter` 选择、`Esc` 收起，并在下方实时提示解析路径、是否为 Git 仓库或不可用原因；`Name` 默认取目录名。
- **New empty workspace（新建空工作区）** — 实时预览在团队工作区根目录下的完整路径，拒绝包含斜杠或已存在的名称。
- **New Git worktree（新建 Git worktree）** — 依次填写 `Repository`（须为 Git 仓库）、`New branch`、`Folder name`（默认由分支名派生）与 `Start from`（默认 `HEAD`）。

三种来源均可选填两个字段：

- **Role（角色）** — 树中名称旁显示的简短头衔（如 Reviewer、Frontend），负责人委派任务时也会看到。
- **Responsibility（职责）** — 一句话描述负责范围，每次执行团队任务时会自动注入该成员指令。

### 返回、离开与停止

Rind 并非单一进程：Agent、任务与共享 Runtime 在后台常驻运行，终端窗口只是观察口。因此“返回”“离开窗口”与“全部停止”三者严格区分，绝不暗中越界：

| 你的意图 | 操作 | 实际行为 |
| --- | --- | --- |
| 打开 Agents 页面 | 在会话空白输入框按 `←` | 打开 Agents 页面，刚离开的会话标记为 `↩` 并默认选中。 |
| 返回刚才的会话 | 在 Agents 侧栏按 `esc` | 重新回到刚才离开的那一个会话（`esc back to conversation`）。 |
| 切换到其他会话 | 在目标会话上按 `Enter` | 原地替换当前屏幕会话，窗口绝不层层堆叠。 |
| 离开 Rind 窗口 | 空闲时连按两次 `ctrl+c` · `/exit` | 关闭所有 Rind 窗口；后台 Agent、任务与共享 Runtime **继续运行**，最后一个窗口退出时会提示仍有几项工作在后台运行。 |
| 停止所有后台工作 | Agents › **Background** › Stop all agents and leave Rind · `rind agents stop --all` | 取消托管任务与运行中轮次，随后停止共享 Runtime 与管理服务并关闭所有窗口；团队、任务记录与会话历史全部保留。 |

`ctrl+c` 始终优先处理最紧迫的当前动作：

1. 轮次运行中：第一次中断当前轮次；中断过程中再按第二次则强制关闭窗口。
2. 输入框非空：清空当前输入文本。
3. 空闲态：第一次提示 `ctrl+c again to leave Rind · agents keep running`（保留 2 秒），再按一次离开，按其他键（或在 Agents 页按 `esc`）取消；非交互终端下一次中断直接退出。

`ctrl+c` 从不承担页面导航：进入 Agents 页面始终使用 `←`。直接运行 `rind agents` 启动时，访问会话前按 `esc` 直接退出，访问过会话后按 `esc` 返回该会话。

从 Agents 打开会话绝不嵌套子窗口：窗口切换通过环境变量 `RIND_AGENTS_HANDOFF` 指向的私有文件交回外层宿主窗口处理，且窗口启动后立即从自身环境中移除该变量，确保子服务与工具进程不会继承它。屏幕上最多只有一个活跃会话，从任一位置执行离开都会干净收尾。未注册目录的独立会话若运行在当前窗口自有 Worker 中，运行期间会拒绝切走以免误杀任务。

**Background** 页面集中展示离开窗口后仍在运行的一切：**Running now** 列出共享 Runtime 中所有运行中的轮次、任务及后台作业；其下展示待确认运行以及两个后台服务的 PID 与运行时长。在服务行按 `Enter` 查看最近日志；检测到新版本安装后，管理服务会提供 **Restart to load the update**（不中断运行中会话，窗口平滑重连）；共享 Runtime 则在所有窗口关闭且空闲后自动更新。底部 `[ Stop all agents… ]` 按钮（快捷键 `S`）默认聚焦 Cancel，明确列出将被停止的运行项与保留的数据，确认后执行 **Stop all agents and leave Rind**。

`rind agents stop` 仅在无运行任务时停止两个后台服务（否则列出活跃工作并以状态码 1 退出）；加上 `--all` 才会一并停止运行中的 Agent，且绝不会为了停止而先把未运行的服务拉起。

### 更新与后台服务指纹

后台服务以分离进程运行。管理服务通过 `serviceInfo`、共享 Runtime 通过 `runtime/info`（无需拉起 Worker 即可响应）各自报告启动时加载代码的指纹（仅基于相对文件名与文件内容计算，与安装路径或盘符大小写无关）。客户端每次连接时比对磁盘代码指纹：

- **空闲且版本过期**：透明停止旧服务并替换为新版本。
- **仍有运行中 Agent**：保留旧服务以免打断任务，在 Agents 与 Background 页面提示有待生效更新；待任务结束后下次连接自动替换，也可在 Background 手动停止重启。

这遵循了 Crush（`restartIfStale`，繁忙时拒绝重启）与 Orca（保留仍持有活跃会话的旧守护进程）的演进原则。

### 对话框与表单

选择对话框为选项编号（`1`–`9` 直接选择，右侧字母对应页面快捷键）；破坏性确认框使用红色边框、默认预选 Cancel（`n`），必须按 `y` 或显式确认才执行。对话框位置固定，输入时不跳动。表单复用聊天行编辑器，完整支持粘贴、光标移动、撤销与 `Shift+Enter`；`Enter` 跳至下一字段并在末字段保存，`Shift+Tab` 上移，`Tab` 下移（目录字段中触发路径补全）。校验未通过的字段禁止离开；保存失败保留已输入内容并在框内提示错误；保存期间敲击的按键会在保存完成后按序重放（除非保存动作打开了新对话框）。

## 成员模型配置

每个成员使用其所在目录的新会话默认配置：模型（连接与模型 ID）与推理强度（reasoning effort），两者可分别设置或保持继承。未显式设置时，Git worktree 继承主仓库目录配置，普通工作区继承 `~/.rind/settings.json`；你直接在该目录打开独立会话时同样使用这套目录默认配置，做到“一目录一配置”，而非按团队分裂。

只有用户与 Manager 可以修改成员模型。在 Agents 页面选中成员按 `Space` 打开 **Model and effort**（仅列出已登录连接）；Manager 调用 `setMemberModel` 与 `clearMemberModel`，每次修改都会出现在你的 Inbox *Changed by the Manager* 分栏中直至忽略。团队负责人与普通成员无权修改任何模型（包括自身模型），单个任务也不携带独立模型覆盖。变更自该成员的下一次任务起生效（新任务以此启动，重试或恢复的任务在运行前切换至此模型），正在运行的工作保持原模型不变。

`rind agents list --json` 输出完整状态；占用目录的运行可用 `rind agents stop <run>` 停止，或在进程已退出且状态为 `unknown` 后用 `rind agents resolve <run> --confirm-stopped` 释放；`rind agents import <legacy-root>` 预览旧版 `.aiteam` 配置，确认无误后加 `--confirm` 导入，导入过程绝不修改旧文件。

当同一工作区属于多个团队时，交互终端会询问要挂载的作用域，非 TTY 环境需显式传入 `--team <id>` 或 `--standalone`。直接对话作为运行项被观测，但其私密消息内容不会广播。管理服务断线重连后会先与 Runtime 回放对账再恢复调度；未确认运行在人工确认停止前持续保留目录锁。

每个受管 Session 绑定唯一管理作用域，共享 Worker 在其上隔离托管多个 Session。`/sessions` 与 `/fork` 会在连接到同一共享 Runtime 的窗口中打开所选历史（分叉还会预填选中的用户消息），返回原窗口时原对话完好保留。也可通过 Agents 页面或 `rind --session <runtime-id> --team <team-id>` 恢复指定成员会话；跨工作区或跨团队会话不会混用当前作用域。未注册的普通 Rind 保持原有会话行为。首个适配器为 Rind；外部 Codex/Claude 进程暂不自动观测。

## 成员可调用的工具

团队成员既不能读取也不能修改组织架构。系统只会告知其自身身份、直属上级与直接下属，并按需授予至多两个工具：

| 工具 | 授予对象 | 调用形式 |
|---|---|---|
| `delegate` | 团队负责人及拥有直接下属的成员 | `{to, brief}` 向直接下属派发任务 · `{new, brief}` 先新建直接下属再派发（带 `new.branch` 时基于团队仓库创建新分支 Git worktree，否则创建空工作区）· `{task, message}` 将已完成或阻塞的子任务发回继续处理 · `{task, cancel: true}` 取消子任务 · `{retire}` 在自己创建的下属完成工作且 worktree 干净后将其退役（绝不强制删除，分支保留） |
| `report` | 任务运行实例 | `{outcome, summary, evidence, artifacts}` 提交交付报告（`artifacts` 为成员工作区内文件，由服务复制给接收方）· `{blocked: {responder, action}}` 向用户、直属上级或直接下属报告阻塞 |

任务运行期间不能直接向用户弹出提问卡，而必须通过 `report` 提交阻塞项。除上述两项外的全部管理能力（含模型设置）均归属用户与 Manager（`agent_management`），服务端拒绝来自普通成员的管理调用与快照订阅。新建空工作区成员默认继承创建者目录的模型，新建 worktree 成员继承所属仓库的模型。

全程零轮询：委派方在其派出的所有子工作全部收敛（已交付、已阻塞或失败）后自动收到汇总唤醒——若父级是任务则重新拉起并将子结果作为输入，若父级是成员或 Manager 的交互会话则通过 Runtime 的 `rind/session/deliver` 作为下一轮消息投递；若目标会话当前未被 Runtime 托管，结果会暂存在管理服务中并在会话下次挂载时立即送达。已交付产物文件会复制到 `state/artifacts/<team>/<recipient>/<task>/<id>/<name>` 并在汇总中附上路径，接收方用 `read_file` 读取（路径仅作指引，Rind 文件工具本身不设沙箱边界）。

派出了子工作的交互会话在空闲等待期间会明确显示 `─ Waiting for <member>`；交付到达时触发带 `delivery` 与 `delivery_text` 标记的 `turn_started` 事件，渲染为 `Delivery` 报告，并以 `meta.kind = "team_delivery"` 存入用户消息历史，确保后续重放仍呈现为团队交付报告而非普通用户输入。报告完整列出成员、任务、结果、摘要、证据、产物路径与后续建议。

## 架构边界（Boundaries）

管理服务独占授权、持久化、任务调度、工作区锁、交付报告与快照订阅；适配器连接共享 Runtime 并翻译生命周期事件。管理服务仅根据执行宿主报告的会话状态判定运行情况，绝不把关闭 CLI 窗口视为任务完成。Runtime 按 Session 接收通用外部工具声明（名称、描述与 JSON Schema）及可选的绝对路径 Skill 文件列表，Runtime 自身不包含任何 Team 概念。模型凭据无法伪造生命周期事件，宿主凭据也无法调用管理变更接口。Manager 会话同时拥有全部 Rind 工具与 `agent_management` 工具，可读取成员文件以核验交付；其系统指令约束它只通过管理接口调整组织与发起审批、不直接改动成员工作区文件（这是指令约定而非沙箱隔离）。Manager 获取的 `snapshot` 是精简概览（成员、未结任务、最近 5 条交付、活跃运行与审批项及省略计数），需要详情时再调用 `getTeam`、`getTask` 与 `readArtifact`；Agents 界面则持有完整快照。

审阅交付与删除团队同样走统一边界：`reviewTask { taskId, decision: "accept" | "rework", feedback }` 仅限用户调用且每次交付只生效一次（返工会为同一负责人生成带 `reworkOf` 的新任务）；`deleteTeam { teamId, confirmName }` 要求用户输入精确团队名，存在运行项时拒绝执行，通过后清理团队、任务与已发布产物（旧版团队再次导入可重建）。释放成员时若其会话正被窗口打开，则转为无团队注册态（`released`）以保证当前轮次与脱离正常完成，脱离后自动清理；仅当目录无活跃引用且无自定义指令或 Skill 时才注销该目录注册。Manager 对非空团队调用 `deleteTeam` 或调用 `cancelRun` 时不会直接生效，而是返回 `{ approval }` 写入用户快照的 `approvals` 列表（目标消失时自动清除），由用户独占的 `resolveApproval { approvalId, approve }` 批准执行或拒绝。

旧版内置于 Worker 的团队发现、`agent_create` 与内置 `delegate` 路径已彻底移除，只读导入器是唯一的旧版迁移入口。CLI 与适配器共享 `rind-runtime-client/`，避免重复实现传输层。

## 分发打包（Distribution）

外部 Windows 分发流水线可通过以下命令暂存全部组件：

```sh
node agent-management/stage.mjs C:/tmp/rind-cli-stage
```

目标目录必须尚不存在。该脚本会编译 TypeScript，复制 CLI、Runtime（含 `node_modules` 与 `skills`）、管理服务、共享客户端及 YAML 依赖，并从 `runtime/src/version.ts` 写入包版本元数据。仍可通过 `RIND_RUNTIME_PATH` 指定自定义 Worker 路径。

## 故障恢复（Recovery）

运行历史有界裁剪以保持写入高速：仅保留最新 512 条请求回执（供幂等重试）、每个会话最近一次已结束运行以及每个任务最近 10 次运行；活跃与 `unknown` 运行绝不裁剪。服务拒绝静默重建损坏的日志：末尾未写完的半行会被安全丢弃，但更早位置的损坏记录或序号断层会阻止启动并保留现场供排查修复。管理服务重启时，原先的活跃运行首先置为 `unknown`，随后与仍在运行的共享 Runtime 对账恢复；排队派发标记会被清空；已崩溃的 Runtime 绝不会自动重放执行。请仅在确认旧进程已退出后解决 `unknown` 运行并显式重试任务。发布产物在复制到用户私有的团队/任务交付目录前会校验其确实位于任务负责人工作区内。

若进程在创建目录/worktree 之后、写入注册表之前意外退出，重试时绝不会覆盖已存在的目录；可在 Agents 页面通过 **Add member › Existing folder** 挂载该目录，或另起名称。代码仓库操作与注册表提交是各自独立的本地步骤，不构成跨文件系统事务。

## 交互与调度设计参考

Agents 页面直接复用 Rind 现有的 TUI 渲染引擎、行编辑器、输入框光标计算与主题系统，不引入任何额外终端框架：

- Codex `codex-rs/tui`（`resume_picker.rs`、`footer.rs`、`key_hint.rs`、`list_selection_view.rs`）：按键加粗/说明暗色的优先级底栏（空间不足整项隐藏）、数字快捷键选择、紧凑相对时间以及按实体标识稳定保持选中项。
- Crush `internal/ui`（`dialog/sessions.go`、`dialog/common.go`、`model/status.go`）：随上下文变化的简短底栏提示配 `?` 全量帮助浮层、默认预选安全项的原地危险确认框，以及自动过期的带类型状态提示。
- Orca（`docs/reference/agent-status-store.md`、`worktree-status.ts`、`smart-attention.ts`）：单一状态投影、折叠分支与团队的最差状态向上聚合、注意力优先排序（待处理 › 未确认 › 运行中 › 空闲），以及将 `unconfirmed` 视为“缺少证据”而非直接判败。
- Paperclip（`ui/src/pages/Agents.tsx` `filterOrgTree`、`lib/attention.ts`、`doc/execution-semantics.md`）：保留匹配节点祖先链的组织树过滤、聚焦人工决策的统一 Inbox、队列优先级排序、显式取消与可操作阻塞项。

任务备注与运行记录直接构成活动轨迹，无需再维护第二套活动数据库、公司模型或复杂权限框架。

## 共享 Runtime（Shared Runtime）

受管 Rind 会话与后台任务共享位于 `RIND_HOME/runtime` 下的单一本地执行宿主。宿主使用现有 Runtime JSONL 协议与私有本地端点，生命周期独立于任何 CLI 窗口；原有的未注册独立运行、网关与 WebSocket 入口同样保持可用。

每个 `RIND_HOME` 严格只运行一个宿主实例：启动过程由锁文件串行化（仅在旧进程确认死亡后回收陈旧锁），端点本身也采用独占发布——先绑定私有临时名，再通过原子链接/重命名覆盖规范端点（且仅替换已被证实死亡的旧端点），确保并发启动者（多终端窗口、`rind run`、`rind config`、管理服务）全部收敛到同一个宿主与同一个 Worker。

停止过程彻底且绝不阻塞下一代宿主：宿主先释放端点（让新宿主可在旧 Worker 收尾期间立即绑定），再断开所有窗口连接，最后按需强制终结 Worker；即使 Worker 在关闭途中提前退出，`runtime/shutdown` 也必定返回确认，绝不留下半关闭僵尸宿主。宿主同时在 `runtime/host.json` 记录自身 PID：若宿主不再响应协议，下一个客户端会先据此终结失响应进程再启动新实例；若 Worker 意外退出，其宿主也会随之退出。

`rind-runtime-client` 包独立负责传输与宿主托管，不含任何 Team 依赖。`session/open` 作为本地宿主操作校验目标工作区、创建或恢复 Session 并挂载外部工具配置（普通远程 WebSocket 客户端无权注入外部工具）。各 Session 的容器、模型请求、工作区、工具授权、提问卡与取消信号彼此隔离；不可变基础服务跨会话共享，空闲执行容器自动释放。

同一 Session 同时至多运行一个活跃轮次；多个窗口可同步观察、通过现有控制协议追加 steer/follow-up 输入或抢答待处理提问（仅首次回答生效）。关闭或脱离 CLI 窗口不会停止执行，重新接入即可恢复完整历史与实时轮次而不会产生重复运行。宿主失联会标记为 Unconfirmed，重新打开会话即可重连核查现场后再决定是否重试。共享 Runtime 本身是常驻后台服务，停止管理服务不会误关无关的独立会话。

成员页面仅列出注册到该团队的会话（每工作区最多 100 条已保存会话加已注册活跃会话），Manager 页面列出 Manager 历史；会话终身保持创建时的作用域，打开团队绝不会混入独立会话或其他团队历史。LLM 追踪为宿主级开关：请在启动宿主前设置 `RIND_TRACE_LLM=1`（单窗口传入 `--trace-llm` 会明确报错拒绝而非静默忽略）。共享历史统一存放在 `RIND_HOME/sessions`，切换隔离环境请设置 `RIND_HOME` 而非自定义 `--session-dir`。当前首个执行适配器为 Rind。
