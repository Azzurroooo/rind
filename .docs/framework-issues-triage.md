# 外部服务器框架问题清单：真伪判定与优化方案

- 来源：`rind-framework-issues-20261021.zip`（`RIND_FRAMEWORK_ISSUES.md` + 4 份 evidence）
- 对照基线：本仓库 HEAD `7c75fac`
- 结论先行：9 项里 **真问题只有 3 个**（R1 核心，R6、R9 部分），其余是「版本/魔改导致」「已有机制被误判」或「方案过度」。最终改 5 处、不新增命令/接口/字段/环境变量，实施结果见第 5 节。

## 0. 先判断来源版本

报告的行号、路径与本仓库对不上，说明对方不是同一份代码：

| 报告引用 | 本仓库实际 | 判断 |
| --- | --- | --- |
| `ipc.ts:251` 抛 SESSION_EXPIRED | [ipc.ts:272](../agent-management/src/ipc.ts#L272) | 版本不同 |
| `service.ts:336` 设 wait 上限 | [service.ts:272](../agent-management/src/service.ts#L272) | 版本不同 |
| `rind/agent/infrastructure/llm/` | `agent/infrastructure/llm/` | 目录前缀不同，疑似外层包装 |
| "worker bridge 收 SESSION_EXPIRED" | `agent/` 下不存在该概念 | 外部桥（Madge）或魔改 |
| 路径 `/dfs/data/.../MadgeAGENT` | 非框架代码 | 本地接入层 |

后文以本仓库代码为准逐项核对。

## 1. 逐项判定

| 编号 | 报告主张 | 判定 | 说明 |
| --- | --- | --- | --- |
| R1 | turn 无看门狗，LLM 无超时 | **部分真（核心真）** | 缺应用层「无进展」判据是真的；「SDK 无超时」不准确，见 2.1 |
| R2 | live 表无 reap、无心跳 | **诊断错误，方案过度** | `watchers` 是窗口数，不是进程持有数，见 2.2 |
| R3 | cancel/retire/retention 不连带终态 | **基本不成立** | cancel 已连带 `session/cancel`；retention 不碰 runtime，见 2.3 |
| R4 | attach 死锁，需 force-close | **前提靠 R1，命令不必加** | 见 2.4 |
| R5 | 管理服务无单实例互斥 | **不成立（根因误判）** | 已有三层互斥；证据是人为 `rm sock`。残留一个真缺口，见 2.5 |
| R6 | `stop --all` 无自保护 | **部分真** | `--all` 本意就是全停；会话内误用是真，见 2.6 |
| R7 | SESSION_EXPIRED 不自愈 | **不属于本框架** | 出问题的是外部 bridge，见 2.7 |
| R8 | wait 上限 60s，缺 settle 唤醒 | **不成立** | 唤醒已存在，60s 是有意设计，见 2.8 |
| R9 | 优雅关闭强杀；日志无时间戳 | **部分真** | 强杀是 R1 的后果；无时间戳的是 stderr 透传行，见 2.9 |

## 2. 分析与证据

### 2.1 R1 模型调用无看门狗（真，但描述需修正）

所有模型调用都经过 [cancellation.py](../agent/infrastructure/llm/cancellation.py) 的两个函数：`await_with_cancellation`（发起请求）和 `iterate_with_cancellation`（读取每个分片）。它们**只响应取消，不判断「多久没进展」**。

各 provider 的实际兜底：

| 路径 | 兜底情况 |
| --- | --- |
| OpenAI chat | SDK 默认单次读超时 600s，但 [provider_service.py:230](../agent/infrastructure/llm/provider_service.py#L230) 设 `max_retries=14`；SDK 重试包在同一个 `create()` 的 await 里，最坏要数小时才返回 |
| OpenAI responses / Anthropic | SDK 默认 600s 读超时，2 次重试 |
| Google GenAI | [google_generative_ai.py:31](../agent/infrastructure/llm/google_generative_ai.py#L31) 未设任何超时 |
| 任意 provider 经网关 | 网关按间隔发 SSE 保活，读超时被不断重置；SDK 丢弃注释行，上层永远拿不到分片 |

所以「连 gateway 头都不打、永远 await」这一说法**证据不足**：zip 里没有 worker 栈（py-spy / asyncio task dump）。但「没有应用层无进展截止」成立，且 `zombie-turn-live.json` 里的现象（`_active` 一直未释放才会触发 `Cannot change a running session's execution configuration`，见 [execution.py:119](../agent/runtime/server/execution.py#L119)）与一次永不返回的 await 一致。

报告建议的「15 分钟硬超时」**不应采纳**：它会杀死仍在持续输出的长流式回复。应判「无进展」，而不是判「总时长」。

### 2.2 R2 live 表 reap（诊断错误）

- [live-sessions.js](../rind-runtime-client/live-sessions.js) 的 live 表是 host **内存**中由事件推导的视图，worker 退出时 `reset()` 会清空，不存在跨进程孤儿条目。
- `watchers` 统计的是**打开该会话的窗口数**。托管任务会话本来就没有窗口，`watchers=0` 不能推出「无活进程持有」。
- 报告提议的「host 向 worker 发 `turn.ping` 质询协程是否存在」：host 与 worker 之间已有进程级 `onExit`；协程是否存在最终取决于 R1，加 ping 只是新增一条接口去观察同一个缺陷。

结论：不做。R1 修好后，turn 会以 `turn_failed` 结束，live 表由现有终态事件自然回到 idle。

### 2.3 R3 终态不连带（基本不成立）

- cancel：[service.ts:1091-1099](../agent-management/src/service.ts#L1091-L1099) 对被取消的 run 调用 `handle.cancel()`，最终走到 runtime 的 `session/cancel` → [execution.interrupt](../agent/runtime/server/execution.py#L618)，取消令牌会让 `await_with_cancellation` 抛出 `CancelledError`，[runtime.py:392-398](../agent/runtime/core/runtime.py#L392-L398) 随即落盘 `turn_cancelled`。
- retention：[retention.ts](../agent-management/src/retention.ts) 只裁剪 management 自己的 state（receipts / tasks / runs 等），从不删除 runtime 的 session meta，也不操作 live 表，「删记录产生孤儿」不成立。
- 真实残留：worker 被强杀 / 崩溃后，磁盘 `meta.turn_state` 停在 `running`，没有人写终态。这是真问题，归入下面的 P1。

### 2.4 R4 attach 死锁（命令不必加）

- `configure_session` 只检查内存中的 `_active/_starting`；换句话说，磁盘上遗留 `running` **不会**触发该报错，只有 worker 里确有一个未结束的执行才会。
- 对真正卡在模型 await 的 turn，`session/cancel` 本就能解锁（取消令牌打断 await）；卡住的根因是没有人保证 await 会返回，即 R1。
- 因此新增 `rind sessions force-close` 是第二条恢复路径，违背「边界唯一」。R1 修好后无需它。
- 附带发现：`_release_if_idle`（[execution.py:839-841](../agent/runtime/server/execution.py#L839-L841)）在存在待投递消息 / 续接任务 / 待唤醒时会保留 `_active`，同样会让配置变更被拒。这是设计行为（配置在执行存续期不可变），报错文案已说明原因，不改。

### 2.5 R5 双 Manager（根因误判）

当前代码已有三层互斥，不是「无锁」：

1. 端点所有权：[listenOwned](../rind-runtime-client/endpoint.js#L23)（发布锁 + 探活 + 身份校验），被占时 `ALREADY_RUNNING`，见 [ipc.ts:394-398](../agent-management/src/ipc.ts#L394-L398)。
2. 启动互斥：[client.ts:222](../agent-management/src/client.ts#L222) 的 `service-start.lock`，锁内二次探测。
3. 记录 nonce：`service.json` 记录 pid+nonce，空闲时自检。

证据 `stop-all-selfkill.jsonl` 里的命令明确执行了 `kill 3 个 pid; rm -f service.sock`。删除 socket 文件而旧进程仍在监听，新实例自然能发布新的 socket → 双实例。这是**协议外干预**，[endpoint.js 头注释](../rind-runtime-client/endpoint.js#L1-L5)已声明只检测不防御。flock 解决不了「有人删文件」。报告的「journal corrupt」在 zip 中无任何证据。

真实残留缺口：旧实例的 nonce 自检被放在 `isIdle()` 之后（[ipc.ts:465-469](../agent-management/src/ipc.ts#L465-L469)、[shared-server.js:214-218](../rind-runtime-client/shared-server.js#L214-L218)）。旧实例只要还有 run 在跑，就永远不去检查自己是否已被取代，于是两个实例同时写同一个 state。

### 2.6 R6 `stop --all` 自杀（部分真）

[agents-commands.js:176-199](../frontend-cli/lib/agents-commands.js#L176-L199)：不带 `--all` 时，有任务在跑会拒绝；`--all` 的语义就是「连正在运行的会话一起停」。证据中该命令被 `User interrupted`（exit -15）取消，是 `--all` 按设计取消了发起它的会话，不是缺陷，而是**在会话内执行了一个本不该在会话内执行的命令**。

报告建议新增 `rind services restart`（停任务 → 停 worker → 停 host → 停 mgmt → 反向拉起 → 全量 reconcile）：这是一套全新的重启编排，而现有 `stop --all` + 任意命令自动拉起已经覆盖，**不采纳**。只需让 `--all` 在 Rind 会话的 shell 里拒绝执行。

### 2.7 R7 SESSION_EXPIRED 不自愈（不属本框架）

- 本仓库 `agent/` 内没有 SESSION_EXPIRED 或 worker bridge；CLI 的重连逻辑在 [agents-session.js:172](../frontend-cli/lib/agents-session.js#L172) 已存在。
- [ipc.ts:272](../agent-management/src/ipc.ts#L272) 把「记录缺失」与「宿主失权」合并为同一条 SESSION_EXPIRED 是事实，但调用方（外部 bridge）该不该重试是接入层职责。拆码、按 `runtimeSessionId` 重绑 token 都是新增接口面，当前没有框架内调用方需要，不做。

### 2.8 R8 wait 60s 上限（不成立）

- 唤醒已实现：[service.ts:293-310](../agent-management/src/service.ts#L293-L310) 的 `waitForDelegations` 订阅状态变化（`onStateChange`）与释放（`onRelease`），状态一变立即返回。
- 60s 是有意设计：工具描述写明「at most once … never in a loop … end your turn to be resumed automatically」，settle 后系统自动续接。
- 上限提到 600s 会撞上 [client.ts:147](../agent-management/src/client.ts#L147) 的 120s 请求超时，变成 `REQUEST_TIMED_OUT`。

### 2.9 R9 关停与日志时间戳（部分真）

- host 自己写的日志行都带 ISO 时间戳（[shared-server.js:38-40](../rind-runtime-client/shared-server.js#L38-L40) `writeLog`）。`runtime-log-no-timestamp.txt` 里三行都是 **stderr 透传**：[shared-server.js:65](../rind-runtime-client/shared-server.js#L65) 的 `onStderr: text => process.stderr.write(text)` 与 [shared-server.js:154](../rind-runtime-client/shared-server.js#L154) 的 `process.stderr.write`，直接落入被重定向的日志文件，无前缀。
- 「优雅关闭永远 30s 强杀」与 `session_index.json.lock` 获取失败是 R1 的下游症状（worker 里有永不结束的 turn → `client.shutdown()` 超时 → 强杀 → 残留锁），无需单独处理。
- 「turn 年龄分位数 / 锁失败计数告警」是新增指标体系，当前没有消费方，不做。

## 3. 优化方案（最小集）

### P0 模型调用「无进展」截止（修 R1）

**位置**：[cancellation.py](../agent/infrastructure/llm/cancellation.py)，一处常量，两个函数各改 1~2 行。所有 provider 共用，无需改各 client。

```python
MODEL_IDLE_TIMEOUT_SECONDS = 600
```

- 新增 `_within_idle_timeout(awaitable)`：`asyncio.wait_for(awaitable, MODEL_IDLE_TIMEOUT_SECONDS)`，超时改抛带说明的 `TimeoutError("The model sent nothing for 600 seconds.")`。
- `await_with_cancellation` 把发起请求包进它；`iterate_with_cancellation` 把每次 `anext` 包进它，每收到一个分片计时重置。两条分支（有无取消令牌）同样适用，取消语义与单次订阅不变。
- 错误归类无需新代码：[errors.py:55](../agent/infrastructure/llm/errors.py#L55) 已把 `TimeoutError` 归为 `status="timed_out"`；流中途超时带 `stream_interrupted` 码，复用 TurnRunner 既有的有界步重试（3 次），仍失败则 `turn_failed` 落盘，`_active` 随 turn 结束释放。
- 600 秒与 SDK 默认读超时一致，仅作用于「无任何解析出的分片」的区间。

**不做**：15 分钟总时长硬超时、90s 首字节重试、新错误码 `model_stream_timeout`（沿用 `timed_out`）。

**取舍**：网关若用「空 delta 分片」当保活，仍会重置计时。这属于网关行为，先不加总时长上限；若线上仍出现，再针对性处理。

**验收**：用不产生分片的假 client 注入 `create()` / 流读取，turn 在阈值后以 `turn_failed(timed_out)` 终结，`_active` 释放，同 session 可再次配置。

### P1 崩溃遗留的 `running`（修 R3 的真实残留）

**核实结论（实施时）**：`session/prompt {resume: true}` 是有文档、有测试的协议能力（[cancellation-and-recovery](../docs/internals/01-runtime/cancellation-and-recovery.md)、`test_runtime_server_protocol.py`）。磁盘 `turn_state=running` 而无活跃执行，**本身就是协议定义的「中断、可续接」边界**，不是脏数据。写成 `failed` 会破坏 resume，故不改磁盘。

**真正的缺陷是误读**：「此刻是否在跑」的唯一事实源是 replay 里的 `live_turn`（worker 内存执行）。各端核对：management（[ipc.ts:84-86](../agent-management/src/ipc.ts#L84-L86)）已把「running 且无 live_turn」判为 failed；CLI 只保存不使用；**Desktop**（`runtime.ts` loadReplayNow）却把 `turn_state=running` 当作活跃 turn 的回退依据，导致崩溃后的会话永远显示运行中。

**做法**：删除 Desktop 的这条回退分支，只以 `live_turn` 判定活跃。零新增。

### P2 旧实例被取代时自行退出（修 R5 的真实缺口）

把 nonce 检查移到 `isIdle()` 判断**之前**：

- [ipc.ts:463-471](../agent-management/src/ipc.ts#L463-L471)、[shared-server.js:212-220](../rind-runtime-client/shared-server.js#L212-L220)：定时器先读 record；仅当记录存在且 nonce 不同（证明已被取代）才 `close`，忙闲不论；之后才进入空闲判断。
- 记录缺失 / 读失败不触发退出，避免误杀。
- 不加 flock、journal nonce、双 nonce 告警。

**验收**：忙碌状态下启动第二个实例并改写 record，旧实例在一个检查周期内退出，只剩一个 `server.js`。

### P3 会话内拒绝 `stop --all`（修 R6）

- **核实结论（实施时）**：共享 host 启动 worker 时已注入 `RIND_SHARED_HOST_PID`（[shared-server.js](../rind-runtime-client/shared-server.js) `createRuntimeClient({ env })`），shell 工具以 `os.environ.copy()` 继承。它的含义正是「本进程是该共享 Runtime 的后代」，即 `--all` 会停掉调用方自身宿主的充要条件。**复用它，零新增环境变量。**
- [stopBackground](../frontend-cli/lib/agents-commands.js#L178) 在 `all` 为真且该变量存在时抛错（CLI 统一以 stderr + 退出码 2 呈现），提示在 Rind 外的终端执行。
- 不带 `--all` 的 stop 本来就对繁忙服务拒绝，保持不变。

### P4 stderr 行补时间戳（修 R9）

- host 的 stderr 就是 `runtime.log`。新增一个 `writeStderr`，给每行加与 `writeLog` 相同的 ISO 前缀；worker stderr 透传、`runtime shutdown:` 行、启动失败堆栈都经它输出。
- 启动竞争失败（另一 host 已在服务）改为带 `ALREADY_RUNNING` 码，并与管理服务 [server.ts](../agent-management/src/server.ts) 一致地不再打印堆栈——它是预期结果，不是错误。

## 4. 明确不采纳的建议

| 报告建议 | 不采纳理由 |
| --- | --- |
| host 每 60s 扫 live 表 + `turn.ping` | live 表是内存视图；watchers 误读；R1 修好后无对象可收敛 |
| `rind sessions force-close` | 与 `session/cancel` 重复；R1 修复后无死锁来源 |
| attach 语义放宽（旧 turn 判死后允许接管） | 破坏「执行期配置不可变」的单一规则 |
| retention 前查 live 表 | retention 不涉及 runtime，前提不成立 |
| `service.lock` flock + journal nonce | 已有端点所有权 + 启动锁 + record nonce；flock 防不了删文件 |
| `rind services restart` | `stop --all` + 自动拉起已覆盖；新增整套重启编排 |
| SESSION_EXPIRED 拆码、token 按 runtimeSessionId 重绑 | 属于外部 bridge 的重试责任；无框架内调用方 |
| wait 上限 600s | 撞 120s 请求超时；唤醒已存在 |
| turn 年龄分位数、锁失败告警 | 无消费方，新增字段 |

## 5. 实施结果（分支 `fix/framework-robustness`）

| 项 | 改动 | 端到端验证（用户视角） |
| --- | --- | --- |
| P0 无进展截止 | `cancellation.py`：一个常量 + `_within_idle_timeout`，请求与每次分片读取共用 | `test/test_model_idle_journey.py`：真实 worker 子进程 + 只发 keep-alive 的假模型。① 一次卡住 → 用户看到 1 次 `turn_step_retry` 后收到回复；② 一直卡住 → `turn_failed`（"sent nothing"），`meta.turn_state=failed`，同会话立即可再发消息 |
| P2 取代自检 | `local-files.js` 新增 `recordedNonce`，host 与管理服务的空闲定时器先判「被取代」再判空闲；两处 `releaseRecord` 复用它；被取代的管理服务跳过 `service.stop()`，不写已移交的 store | `shared-runtime.test.js` / `ipc.test.js`：窗口仍连接时改写 record → 旧实例停止服务、日志 `reason=superseded`、新 record 保留 |
| P3 会话内拒绝 | `agents-commands.js` 一行判断，复用 `RIND_SHARED_HOST_PID` | `agents-stop-in-session.test.js`：模型在会话 shell 里执行 `rind agents stop --all` → 工具结果为拒绝文案，会话继续并完成回复（去掉修复后该用例失败，复现自杀） |
| P4 日志时间戳 | `shared-server.js` 的 `writeStderr` | `shared-runtime.test.js`：detached host 的 worker 启动即失败，`runtime.log` 每一行（含 worker 多行报错）都带 ISO 时间 |
| P1 崩溃遗留 | Desktop `loadReplayNow` 删除 `turn_state=running` 回退分支 | 逻辑删减，以 `live_turn` 为唯一依据 |

> [!NOTE]
> zip 缺少 worker 栈与完整 `runtime.log`，R1 的「具体卡在哪个 await」无法证实；上线 P0 后若同类 turn 仍卡住，请抓取 `py-spy dump` 再判断。
