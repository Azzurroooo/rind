# 自动拉起复盘包：真伪判定与优化方案

- 来源：`rind-autostart-review-20261021.zip`（`REPORT.md` + 12 份 evidence）
- 对照基线：`2ddf404`（含上一轮 `fix/framework-robustness` 的 5 个修复，见 [framework-issues-triage.md](framework-issues-triage.md)）；本轮实施在分支 `fix/workspace-busy-guidance`
- 结论先行：报告的**机制描述基本准确**，但**三条诊断是错的**（日志被截断、journal 被裁剪、retention 删会话），**两条建议不应采纳**（停服冷却标记、拉起 flock）。真正需要框架改的只有 **1 处代码 + 1 处文档**，其余要么上一轮已修，要么属于接入方（Madge 桥）。

## 0. 版本对照

对方 `git reflog`：10-12 检出 v0.10.0，**10-15 回到 main，10-20 22:54 才 pull 到 `7c75fac`**。I1（15:42）、I2（21:52）、I3（21:54）全部发生在 pull 之前，跑的是更早的 main。报告引用的代码（`client.ts:217-222`、`shared-runtime.js:150`）与本仓库一致；`agents-session.js:74` 实为 [agents-session.js:86](../frontend-cli/lib/agents-session.js#L86)。机制层面可以对照；事故现场的行为要以「当时的旧代码」理解，且他们的树里没有上一轮的 P0/P2/P3/P4 修复。

## 1. 报告主张逐条判定

| 主张 | 判定 | 依据 |
| --- | --- | --- |
| 有 user-token 即满足门槛，本机所有 CLI 都走管理服务并可自动拉起 | **属实，是设计** | [agents-session.js:86](../frontend-cli/lib/agents-session.js#L86)；见 2.1 |
| `service-start.lock` 只串行化启动，无法阻止 rm sock 后双实例 | **属实但已修** | 双实例是「旧进程仍活 + sock 被删」，上一轮 P2 让旧实例在一个检查周期内因 nonce 被取代而退出；见 2.2 |
| R5 补充：spawn 前需 flock 校验 `service.json` 存活 | **已具备，不采纳** | 启动锁内已二次探测，且有 `waitForStartingService`；[client.ts:222-226](../agent-management/src/client.ts#L222-L226) |
| R6 补充：`stop --all` 后写冷却标记，拒绝自动拉起 | **不采纳，且与自身证据矛盾** | 见 2.3 |
| R9 补充：`service.log` 改追加不截断 | **诊断错误** | 本来就是追加：[client.ts:227](../agent-management/src/client.ts#L227) `open(..., "a")`、[ipc.ts:46-47](../agent-management/src/ipc.ts#L46-L47) `appendFile`；仓库内没有任何代码截断它 |
| journal 11 小时记录「被 retention 裁掉」 | **诊断错误（设计行为）** | 见 2.4 |
| 10 个失败会话「已被 retention 清理」，retention 删除制造孤儿 | **诊断错误** | 见 2.5 |
| 会话库 6509、日增 78–131 | **属实，非缺陷** | 见 2.5 |
| I1 锁战：客户端超时 ≠ 服务端停止，重试撞锁 | **属实，机理需修正** | 见 2.6 |
| I3 4 小时空窗，轮询每 10s 复活服务 | **叙述自相矛盾** | 见 2.3 |
| I4 a063a0bf 属 port_runner_watch，同族故障 | **属实** | 同 R1，上一轮 P0 已覆盖 |
| L6 桥 poll 无异常捕获、不处理 gone | **本地问题** | Madge 桥代码，非框架 |
| 要求 spawn 记录「拉起者」 | **不采纳** | 见 2.7 |

## 2. 分析

### 2.1 自动拉起是什么、为什么存在

链路（与报告一致）：任意需要管理服务的 CLI 调用 → [connectManagement](../agent-management/src/client.ts#L155-L245) → 连不上则在 `service-start.lock` 内 spawn 脱离式 `server.js`。服务空闲 15 分钟自行退出（[ipc.ts](../agent-management/src/ipc.ts) `DEFAULT_IDLE_TTL_MS`），所以「服务没在跑」是常态，不是故障；「停了就是停了」不是本框架的语义，**按需拉起 + 空闲退出才是**。

一个值得记录的放大点：[agents-session.js:112-142](../frontend-cli/lib/agents-session.js#L112-L142) 为了判断「当前目录是不是已注册成员」，要先连管理服务取 snapshot（未注册则 `plainSession`）。也就是 user-token 存在后，**即便在未注册目录里的普通 `rind run`，也会为了一次查询拉起服务**。这是为了让已注册目录的 `rind run` 一律遵守团队规则（一目录一个运行、可被 Agents 页看到）的代价；要避开它就得绕过 store 直读 snapshot 文件，等于复制一份注册表逻辑。不改。

### 2.2 I2 双实例

`rm -f service.sock` 之后旧进程仍在监听已被 unlink 的 inode；`agents list` 发现 sock 不存在 → 在启动锁内 spawn 新实例，新实例发布新 sock 并覆盖 `service.json`。所以是「旧 + 新」共存，不是「两个新实例」竞争，启动锁并无漏洞（两个并发的 `agents list` 会在锁上排队，后者直接连上前者）。真正的缺口是旧实例忙碌时不检查自己是否已被取代——上一轮 P2（提交 `9ef8803`）已修（先判被取代、与忙闲无关；被取代的管理服务不再写已移交的 store），并有端到端用例。

### 2.3 I3 空窗与「停服冷却标记」

- 会话内 `stop --all` 自杀：上一轮 P3 已修（会话内直接拒绝）。
- 报告提议冷却标记，理由是「任何 bot/脚本轮询都能在用户停服后 10s 内复活服务」。**但同一份报告的证据是服务 4 小时没有被复活**（`service.json`：`startedAt` 为 10-21 01:34）。如果 bot 真的每 10s 调一次 `agents task show`，每一次都会拉起服务，空窗不可能存在。唯一自洽的解释是：**没有任何 CLI 调用到达**，即 bot 的轮询早就卡住（报告 L6 自己也承认）。空窗是接入方的问题，不是自动拉起的问题。
- 冷却标记是新增持久化状态 + 新分支（拉起路径读标记、`stop` 写标记、显式重启要清标记、标记过期规则），并把「按需拉起」变成需要人工介入的模式，违背轻量与易用性。不采纳。

### 2.4 journal 断档不是丢失

[store.ts](../agent-management/src/store.ts) 每 `rotateEvery = 256` 条把全量状态写入 `snapshot.json`，然后截空 `events.jsonl`。报告给出的当前首条 `seq=76545`：`76544 = 299 × 256`，正好是一次快照边界。现场读到的 76302 与 76545 之间只有 243 条，位于同一个轮转窗口内，这些变更都在 snapshot 里。**没有任何数据丢失**，也不是 retention；「journal corrupt」是上一轮已分析的双实例共写所致。

### 2.5 会话数量与「retention」

- 仓库里**没有**运行时会话的自动清理：`agent/` 中唯一的保留期逻辑是 [tool_output_store.py](../agent/infrastructure/persistence/tool_output_store.py) 的 7 天工具输出与 task journal 输出；[retention.ts](../agent-management/src/retention.ts) 只裁剪 management 自己的 receipts/tasks/runs，不碰 runtime 会话文件。
- 那 10 个会话是怎么消失的：它们在 `hostTurnStart`（[execution.py:529-530](../agent/runtime/server/execution.py#L529-L530) 的 `before` 钩子，先于用户消息落盘）因 `WORKSPACE_BUSY` 失败，**首条消息尚未保存**；Dispatcher 在 [dispatcher.py:606-612](../agent/runtime/server/dispatcher.py#L606-L612) 对失败的首个 prompt 调用 [_discard_if_unsaved](../agent/runtime/server/dispatcher.py#L784-L788)，按设计把空会话丢弃并广播 `session_discarded`。所以既没有「会话污染」，也没有「删除造成孤儿」——失败的尝试什么都没留下，是正确行为。
- 6509 个会话、日增 ~100：每个 `rind run`（无 `--session`）本来就是一个新对话，用户可在 `/sessions` 或 Desktop 删除。没有性能证据（列表延迟、索引大小）表明需要自动清理；加 `prune` 命令或后台清理是新功能，不做。

### 2.6 I1 锁战：真实机理

证据链（bot.log）：15:42 第一次尝试 `headless timeout >600s` → 15s 后重试，**第二次起全部 `Another run owns this workspace`**，直到 16:45 放弃；16:37 的第二条消息同样 5 次全败。

框架侧事实：
1. 已注册成员的目录**一次只允许一个运行**（[workspaceBusy](../agent-management/src/service.ts#L469-L471)，`newRun` 抛 `WORKSPACE_BUSY`），这是有意设计；失败的尝试因 2.5 被丢弃，不留痕。
2. 桥的 600s 超时在 Python 里是 `subprocess` 的超时，默认发 **SIGKILL**。[one-shot.js](../frontend-cli/lib/one-shot.js) 只在 SIGINT/SIGTERM 时 `session/cancel` 自己的回合（`onSignal`），SIGKILL 不可捕获——客户端消失，**回合继续在共享 host 里跑**，运行记录保持活跃，占着目录。这就是「客户端超时 ≠ 服务端停止」。
3. 第一次的回合之后持续了至少一个小时仍占着目录。已有证据无法判定它是在做真实工作、卡在模型流（上一轮 P0 已对此设 600s 无进展上限）还是卡在工具上——**该会话 id 没有进入证据**（第一次失败信息里没有 session，且后续会话已丢弃），日志也没有当时的运行状态。不能凭空归因。

框架缺口只有两个，都很小：
- **报错不说是谁占着、怎么办**：`Another run owns this workspace. Wait for it to finish or resolve its unknown status.` 没有运行 id，调用方无法诊断，也不知道框架其实已有 `rind agents stop <run>` / `resolve <run> --confirm-stopped`（[agents-commands.js:163-164](../frontend-cli/lib/agents-commands.js#L163-L164)）。这也正是报告多次抱怨的「无法归因」。
- **SIGTERM 才能取消回合**这一点没有写进文档，调用方（桥）不知道应当先 SIGTERM 再 SIGKILL。

### 2.7 「拉起者留痕」

I3 的空窗不是「不知道谁拉起了服务」，而是**根本没有人拉起**（2.3）。给 `service started` 日志加父进程命令行，需要读 `ps`，且脱离式子进程的父进程往往已经退出，查不到东西。有时间戳的 `service started` 与调用方自己的日志对时即可归因（`runtime.log` 现在每行带时间，上一轮已修）。不加字段。

## 3. 优化方案

### A1 busy 报错指明占用者与出路（代码）

[service.ts](../agent-management/src/service.ts) 把 `workspaceBusy`（返回布尔）改成返回占用中的运行 `busyRun`，三处调用方（`newRun`、两处调度跳过）只用其真值；`newRun` 的报错改为：

```text
Run <id> (<status>) owns this workspace. Wait for it, or run `rind agents stop <id>`.
Run <id> (unknown) owns this workspace. Wait for it, or run `rind agents resolve <id> --confirm-stopped`.
```

- 零新增接口/字段/错误码；`WORKSPACE_BUSY` 码保持，消息多带两个已有数据。
- 消息只给一种出路：`status === "unknown"` 给 `resolve`，否则给 `stop`。
- 无其他代码引用该消息文本（已 grep：仅 `service.ts:475` 定义，`service.ts:89` 的注释不依赖它）。

**验收（用户视角）**：在已注册成员目录里让一个 `rind run` 长时间运行，再起第二个 `rind run`：第二个以非零退出，stderr 里有运行 id；照提示执行 `rind agents stop <id>` 后，第一个运行结束，再次 `rind run` 成功。

**实施**：提交 `f2d507e`（分支 `fix/workspace-busy-guidance`）。端到端用例 [workspace-busy-journey.test.js](../frontend-cli/test/workspace-busy-journey.test.js) 以真实 CLI 进程 + 假模型完整走通上述流程。

### A2 文档写明如何正确终止 `rind run`（文档）

[one-shot.md](../docs/internals/07-surfaces/one-shot.md) 及 zh-CN：补一段——`SIGINT`/`SIGTERM` 会取消本次回合；`SIGKILL` 无法被捕获，回合会继续在共享 host 中运行并占用该目录，直到它自行结束或被 `rind agents stop <run>` 终止。给自动化调用方的建议：先 SIGTERM，等待数秒，再 SIGKILL。

**实施**：与本文同一提交落地，并在两篇文档的「验证」中链接上述端到端用例。

### A3 本地接入层（不属框架，供 Madge 桥参考）

- 超时处理改为 `terminate()` → 等 5–10s → `kill()`，让 `rind run` 自己取消回合并释放目录（这是 I1 的第一杠杆）。
- 区分「目录被占用」与其他失败：占用时不要走 15/30/60/120/240s 的重试梯度（占用者不会因你重试而结束），按 A1 的提示停掉占用者或直接报忙。
- `poll` 循环补 `gone` 分支、异常捕获、退避；任务通道（`rind_team`）已替代 oneshot，是正确方向。
- coordinator 不要执行服务操作（上一轮已述）。

## 4. 明确不采纳

| 建议 | 理由 |
| --- | --- |
| `stopped.marker` 冷却标记 | 新增持久状态与分支；改变「按需拉起」语义；证据显示空窗并非被轮询复活 |
| spawn 前再加 flock 校验 | 启动锁 + 锁内二次探测 + 等待启动中服务已具备 |
| service.log 改追加 / 滚动归档 | 已是追加；没有证据显示日志过大需要归档 |
| 记录拉起者命令行 | 脱离式子进程的父进程多已退出；无法可靠获取；空窗与此无关 |
| 自动清理会话 / `prune` | 无性能证据；失败尝试已被丢弃；属新功能 |
| 为 journal 保留更多历史 | 快照即全量状态，断档是压缩不是丢失 |
| 未注册目录跳过服务拉起 | 需绕过 store 复制注册表读取逻辑，得不偿失 |

## 5. 上一轮修复的覆盖情况

| 事故 | 上一轮修复 | 本轮结论 |
| --- | --- | --- |
| I2 双实例 | P2 旧实例被取代即退出 | 已覆盖 |
| I3 stop --all 自杀 | P3 会话内拒绝 | 已覆盖；空窗属接入方 |
| I4 僵尸 turn | P0 模型无进展 600s 上限 | 已覆盖 |
| I6 观测 | P4 `runtime.log` 每行带时间 | 已覆盖；其余「缺失」为误判 |
| I1 锁战 | — | A1 + A2 + 桥侧 A3 |

> [!NOTE]
> I1 中「第一个回合为什么持续超过一小时」仍无证据。若复现，请在失败当下保存 `rind agents list --json`（看 `runs` 里的状态与会话 id）、`runtime.log`（现已带时间）以及对应会话目录；A1 落地后，报错本身就会给出占用的运行 id，抓取成本更低。另外需知 P0 的 600s 限制对「流中途反复停顿」最坏会累计约 40 分钟（1 次 + 3 次有界重试），这仍是有限的，但若线上确有此类，应改为不重试 `timed_out`，再评估。
