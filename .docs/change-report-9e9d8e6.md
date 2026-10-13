# Rind 变更报告（基线 9e9d8e6 → b6742d8）

> 范围：`9e9d8e6..b6742d8`（分支 `perf/context-efficiency`）
> 规模：12 个提交，86 个文件，+2235 / −260 行
> 内容：用户提出的 9 个问题 + 运行中暴露的 3 个衍生问题（宿主难以关闭、宿主工作目录占用、测试残留）
> 原则：每个修复都能在 opencode / pi / codex / orca / paperclip 的既有实现中找到依据；不牺牲 agent 能力；接口最小、无冗余字段；全部改动附带确定性回归测试与真实进程的端到端测试。

---

## 0. 提交总览

| # | 提交 | 标题 | 对应用户问题 |
|---|------|------|--------------|
| 1 | `1488650` | chore: ignore private e2e acceptance directory | 仓库卫生 |
| 2 | `1bcef3e` | fix(models): list only connections that are configured | 问题 8 |
| 3 | `fd02f97` | fix(agents): the Manager's folder is the Manager, however you enter it | 问题 1 |
| 4 | `1f1e463` | fix(runtime): one host and one worker for every entry point | 问题 3 |
| 5 | `bb43a01` | feat(agents): delete a conversation from Agents management | 问题 2 |
| 6 | `3ca13ee` | perf(agents): one bounded page per folder for Independent | 问题 4 |
| 7 | `80bb59a` | perf(cli): open long conversations on their newest messages with /history paging | 问题 5 |
| 8 | `9007509` | fix(context): compact an over-budget history instead of refusing | 问题 6 |
| 9 | `9f898d2` | feat(cli): show waiting on delegated work and render deliveries as reports | 问题 7 + 9 |
| 10 | `51f07db` | fix(runtime): keep the shared host out of the caller's folder | 衍生 1 |
| 11 | `32e6d33` | test: remove the temporary homes the CLI tests create | 衍生 2 |
| 12 | `b6742d8` | fix(runtime): a stopping Runtime always stops, and a stuck one can be ended | 衍生 3 |

### 参考实现的对照关系（本报告引用的“依据”）

| 参考 | 仓库路径 | 引用的机制 |
|------|----------|-----------|
| opencode | `E:\code\agent1\opencode` | provider 凭证过滤（`provider/provider.ts`）、TUI 尾部窗口（`context/sync.tsx` 100 条）、旧区压缩 head/tail 预算（`session/compaction.ts` select()） |
| codex | `E:\code\agent1\codex` | 自动压缩阈值与输入裁剪（`codex-rs/core/src/compact.rs` “从最旧一条条删，保留最近消息与缓存前缀”）、resume 初始尾部窗口（`tui/src/app_server_session/history.rs` `INITIAL_HISTORY_TURN_LIMIT = 5`）、模型按登录过滤（`protocol/src/openai_models.rs` `filter_by_auth`） |
| pi | `E:\code\agent1\pi` | 压缩时 tool result 截断到 2000 字符、丢弃 thinking（`coding-agent/src/core/compaction/utils.ts`） |
| orca | `E:\code\agent1\orca` | daemon 端点所有权（`src/main/daemon/daemon-endpoint-ownership.ts`：私有绑定 → link → 仅替换“已被证明死亡”的条目）、实例锁（`src/main/orcad/orcad-instance-lock.ts`）、陈旧 daemon 击杀（`daemon-stale-kill.ts`、`daemon-pid-identity.ts`） |
| paperclip | `E:\code\agent1\paperclip` | Run result 交付卡（`ui/src/components/task-chat/TaskChatProtocolCard.tsx`：disposition/summary/verification/remainingWork/artifacts/blocker）、证据诚实（`native-status-arbitration.md`）、有界渲染与轮询策略（`useSharedPolling`、`attention.ts`） |

---

## 1. 【问题 8】`/model` 列出未登录 provider —— `1bcef3e`

### 用户需求
“明明没有登录 openai 的 provider，为什么 `/model` 会加载 openai 模型？请修复。”

### 根因（两条独立路径）
1. **运行时目录侧**：`ProviderServiceImpl._catalog()` 在枚举完有凭证的连接之后，**无条件补入当前选择**（`settings.provider/model` 或会话保存的选择）。用户登出/换 provider 后，旧的 `openai` 选择仍被补进目录。
2. **CLI 菜单侧**：`frontend-cli/lib/model-menu-state.js` 的 `groupModels()` 在“当前模型不在列表里”时把它**无条件地加进菜单**（并在没有该 provider 分组时新建分组），依赖 `initialize` 下发全量 provider 名称表渲染标题。

参考：opencode 的 `/model` 面板只遍历 `Provider.list()`（config/env/auth/plugin/autoload 命中后才存在），当前选择只是高亮，不会凭空补入；codex 的 `filter_by_auth` 只展示与当前登录方式匹配的模型。

### 改动细节
| 文件 | 改动 |
|------|------|
| `agent/infrastructure/llm/provider_service.py` | `_catalog()`：补入当前选择前增加 `self._credential_source(settings, definition) != "none"` 判定；连接没有任何凭证来源（auth.json / settings / 环境变量）时不再进入目录 |
| `frontend-cli/lib/model-menu-state.js` | `groupModels()`：无法在当前列出的连接中找到 provider 时，不再补入当前模型；规则与运行时一致（“登出的连接不是可选项”），保留了“连接已配置但模型未枚举”时的补入 |
| `test/test_provider_auth.py` | 新增 `test_list_models_keeps_unconfigured_current_connection_out`：settings 指向 openai、无凭证、无环境变量 → 目录为空 |
| `frontend-cli/test/model-menu-state.test.js` | 新增用例：当前模型属于未列出连接时从菜单消失；旧的“字符串列表补入当前模型”用例保留 |
| `docs/internals/06-models/model-catalog.md` / `.zh-CN.md` | 更新“当前选择补入”的语义说明 |

### 验证
- `python -m pytest test/test_provider_auth.py`：82 通过。
- `node --test test/model-menu-state.test.js`：8 通过。

---

## 2. 【问题 1】Manager 从默认文件夹进入与从 Agents 页进入不一致 —— `fd02f97`

### 用户需求
“manager 从 manager 默认文件夹进入，与从 agents management 进入 manager，表现不一致；从 manager 默认文件夹进入应当与从 agents management 进入完全一致。”

### 根因
- “Manager”的身份在系统里由**工作区**决定（`agent-management/src/ipc.ts` 中 `sessionTools` 以 `agent.canonicalWorkspace === manager 目录` 授予 `agent_management`）。
- 但 CLI 侧 `prepareManagement()` 只有在带 `--manager`（Agents 页“New conversation with Manager”）时才认定 Manager：
  - 从 manager 文件夹直接运行 `rind`：若该文件夹尚未被注册过 Manager agent，则 `agent` 查找失败 → **退回 plain session**（无管理工具、无注册）；
  - 即使已被注册，`-c` 也走普通 agent 的恢复路径，label/scope 标记不同。

### 依据
设计文档 `docs/agents-management.md`：“**Manager** lists Manager conversations and starts new ones in its own working directory.” —— 文件夹本身就是 Manager 的身份；Agents 页 `sessionTools` 已按工作区判定。修复即把 CLI 入口对齐既有判定。

### 改动细节
| 文件 | 改动 |
|------|------|
| `frontend-cli/lib/agents-session.js` | 新增 `sameDirectory(left, right)`（realpath + win32 小写化，文件夹不存在时按 `path.resolve` 比较）；`prepareManagement()` 计算 `asManager = options.manager || await sameDirectory(cwd/--cwd/--dir, <root>/manager)`；`asManager` 时跳过 plainSession 早退、使用 manager 文件夹作为 workspace、`attachSession { manager: true }`（触发 Manager agent 注册）、label 为 “Manager”、`chatContext.manager = true`（后续从该窗口打开的子窗口继续以 `--manager` 打开）；`-c` 在 manager 模式下通过 `listSessions { manager: true }` 恢复 Manager 最近会话 |
| `frontend-cli/test/agents-lifecycle.test.js` | 新增集成测试：全新 RIND_HOME（服务从未运行）→ `chdir` 到 `<home>/agents-management/manager` → `prepareManagement` 真实拉起管理服务 → 断言 `chatContext.manager === true`、label 为 `Manager`、工具含 `agent_management`、服务快照中该文件夹注册为 Manager 且窗口会话挂在 Manager 名下 |
| `docs/agents-management.md` / `.zh-CN.md` | 补充“该文件夹就是 Manager 的身份：在它里面运行 Rind（或 `--cwd`/`--dir` 指向它）与从本页进入完全一致” |

### 验证
- 上述集成测试通过（约 4s，真实服务 + 真实共享内核）；`agents-lifecycle` 全文件 13/13 通过。

---

## 3. 【问题 3】保证“永远只有一个内核” —— `1f1e463`

### 用户需求
“one-shot / rind / rind -c / rind send 有可能会打开新内核吗？设计是所有共用一个内核。内核能够保证永远只有一个吗？请排查，可做端到端测试遍历所有情况，核实 runtime 和 management 的 pid 是否永远保持一致。”

### 排查结论（修复前）
- `rind`、`rind -c`：共享宿主（Host + Python Worker）；`rind send`：只连接、从不启动 —— 这两个没问题。
- **`rind run`（one-shot）在“非交互且未注册文件夹”时使用私有 Python worker**（与交互窗口不共享）；`--trace-llm`/`--session-dir` 亦私有（后者是合理例外）。
- **并发启动存在竞态**：多个入口同时 `connectSharedRuntime` 时各自 spawn 宿主；Unix 下旧代码在 listen 前 `unlink` 端点文件，存在 TOCTOU，可能在旧宿主仍存活时把 socket 名字换掉，造成两个宿主同时在线。
- **管理服务（management）的端点**有同样的 Unix `probe→unlink→listen` 竞态。

### 依据
- orca `daemon-endpoint-ownership.ts`：**“只有把自己发布到规范端点的 daemon 才能改动该目录项，且只能替换它自己刚刚证明死亡的条目；任何角色都不删除不是自己创建的名字。”** 协议：私有 `bind` → 独占 `link` → EEXIST 时用 connect 证明 incumbent 已死 → 复查名字未换手 → `rename` 发布 → 发布后自检。Windows 命名管道按名字互斥，`listen` 本身即协议。
- orca `orcad-instance-lock.ts`：锁记录 `{pid, startedAt, nonce}`，`wx` 独占创建，**按 rename 抢占回收**，释放时校验 `nonce`（绝不删除后来者的记录）。
- orca `daemon-pid-identity.ts`：只有 `ESRCH` 证明进程已死，`EPERM` 视为仍存活。

### 改动细节
| 文件 | 改动 |
|------|------|
| `rind-runtime-client/endpoint.js`（新增） | `listenOwned(server, endpoint)`：Unix 走“私有绑定 → `link` → 失败时 probe（连接测试）→ 证明死亡且条目未换手才 `rename` → 发布后校验 inode 归属”；Windows 走 `listen(pipe)` 的 `EADDRINUSE` → `EndpointOccupiedError`。任何输家绝不 serve。导出 `probeEndpoint`（供客户端回收逻辑复用） |
| `rind-runtime-client/shared-server.js` | 用 `listenOwned` 替换旧的“probe→unlink→listen”；已被占用时抛 `Shared Runtime is already running.` |
| `rind-runtime-client/shared-runtime.js` | 新增宿主启动锁 `host.lock`：`open(wx)` + `{pid, at, nonce}`；存活进程持锁时等待，**死进程的锁按 rename 回收**，残缺记录给 10s 写宽限；释放前重读并校验 nonce。`createSharedRuntimeClient.start()` 失败不再缓存 rejection（下次 ensure 可重试） |
| `frontend-cli/lib/agents-session.js` | `plainSession(args, shared, home)`：参数从“interactive”改为“是否共享内核”；`prepareManagement` 增加 `shareRuntime`（默认等于 `interactive`） |
| `frontend-cli/lib/one-shot.js` | `rind run` 默认 `shareRuntime: true`：与窗口共用同一内核；`--trace-llm`/`--session-dir` 仍私有（文档注明原因）；仅私有模式保留“Worker exiting”提示 |
| `agent-management/src/ipc.ts` + `runtime-client.d.ts` | 管理服务端点改用 `listenOwned`；被占时抛 `ALREADY_RUNNING` |
| `docs/agents-management.md` / `.zh-CN.md`、`docs/internals/07-surfaces/one-shot.md` / `.zh-CN.md` | 新增“同一 RIND_HOME 只有一个宿主”的机制说明；one-shot 改为共享语义 |

### 测试与证据（`frontend-cli/test/single-runtime.test.js` 新增，全部为真实进程）
1. **并发收敛**：4 个 node 子进程同时 `connectSharedRuntime` → 所有客户端报告的 host pid 与 worker pid 各只有一个；随后复核存活的 host 就是大家看到的那个。
2. **陈旧锁回收**：预写一个死 pid 的 `host.lock` → 启动照常成功。
3. **端点占用**：同一端点第二次 `startSharedServer` 被拒（Windows 管道分支；Unix 分支由 `endpoint-ownership.test.js` 覆盖，Windows 跳过）。
4. **`rind run` 复用内核**：同一 home 连续两次 `rind run`（真实 Python worker + 本地假 provider）→ 第二次仍是同一 host pid 与同一 worker pid，且 host 在运行结束后继续存活（共享设计）。
5. **`rind send` 绝不启动内核**：冷 home 中 `rind send` 报“无窗口”且事后无端点可连接。
6. **management/runtime pid 一致**：真实管理服务 + 真实宿主；`serviceInfo.runtime.pid === runtime/info.pid`，`startedAt` 相同；第二个管理客户端读到的管理进程 pid 一致。

---

## 4. 【问题 2】Agents 管理界面删除会话 —— `bb43a01`

### 用户需求
“在 agents management 界面，增加删除 session 的功能。”

### 根因/缺口
- 运行时早就有 `session/delete`（Python），但管理服务没有任何删除入口，CLI Agents 页也没有对应操作。
- 直接删除还有三个**未闭合的缺口**（排查中发现）：
  1. 删除后没有任何广播，共享宿主 live 表与其他窗口不知道会话已消失；
  2. **已删除的会话会被“打开”路径复活**：`JsonlSessionStore._ensure_session_sync` 在会话目录缺失时会重新 `_create_session`；窗口首次消息的“草稿材料化”（`_materialize_draft_sync`）也会在删除后重建目录；
  3. 删除管理侧记录时，等待投递的 delivery 与 runs 需要一并清理，否则会出现幽灵记录。

### 依据
- 运行时既有的 `session_discarded` 事件与 `live.forget + peer.sessions.delete` 模式（本仓库既有契约，直接镜像为 `session_deleted`）。
- orca/paperclip 的“删除即从所有列表消失、订阅者同步”语义。

### 改动细节
| 层 | 文件 | 改动 |
|----|------|------|
| 运行时 | `agent/runtime/server/dispatcher.py` | `_delete_session`：删除后**先** `_send_event({"type":"session_deleted", ...})`（此时仍未退订，持有该会话的窗口能收到），再 `_subscribed.discard`，最后应答 |
| 共享宿主 | `rind-runtime-client/shared-server.js` | 收到 `session_deleted`：`live.forget(id)` + 所有 peer 的 `sessions` 移除该 id（与 `session_discarded` 相同处理） |
| 永久删除 | `agent/infrastructure/persistence/jsonl_session_store.py` | 新增构造参数 `create_missing`（默认 `True`）与 `mark_deleted()`；“打开已有会话”路径传 `create_missing=False`，目录缺失时抛 `LookupError` 而不是重建；`_materialize_draft_sync` 在 `create_missing=False` 时拒绝材料化——删除后任何晚到的写入都不能重建会话 |
| 同上 | `agent/runtime/server/session_service.py` | `delete()`：pop 草稿并 `mark_deleted`，无论草稿还是持久会话都执行真正的文件删除与索引移除；`discard_unsaved()` 同样 `mark_deleted`；`_open_store_from_info` 传 `create_missing=False` |
| 同上 | `agent/infrastructure/persistence/session_index_repository.py` | `remove_session()` 在索引文件不存在时直接返回（避免 filelock 为“从未落盘的会话”创建目录） |
| 同上 | `agent/runtime/server/execution.py` | `background_wait()` 把“已关闭/已抑制”判定提到读取 goal 之前，已删除会话不会在后台轮询里报错 |
| 同上 | `agent/bootstrap/container.py` | 指定 `session_id` 的启动（恢复）传 `create_missing=False`：请求的会话必须存在 |
| 管理服务 | `agent-management/src/service.ts` | 新增 `forgetSession`（user-only）：拒绝运行中的 runs；`dropSession` + 删除该会话的待投递 delivery |
| 管理服务 | `agent-management/src/ipc.ts` | 新增 `deleteSession`（user-only）：先查运行中 runs / live turn / `watchers > 0`（有窗口在屏时拒绝），再走宿主 `session/delete`，成功后 `forgetSession` |
| CLI | `frontend-cli/lib/agents-page.js` | 新增 `deleteConversation(runtimeSessionId)`：调用 `deleteSession`、清空 history/managerHistory/independent 缓存、若 `returnTo` 指向该会话则清除（Esc 不再返回已删除会话） |
| CLI | `frontend-cli/lib/agents-actions.js` | 所有会话行（Independent 与成员/Manager）的 Space 菜单新增 **“Delete conversation…”**（danger，中文/英文文案同风格，说明“消息永久删除、文件保留”） |
| CLI | `frontend-cli/lib/event-controller.js` | 处理 `session_deleted`：若删除的是当前会话，清空 `session_id` 并提示“下一条消息会新建会话”（窗口优雅降级） |

### 测试与证据
- Python：`test/test_runtime_server_delete.py` 新增“删除后广播 `session_deleted`（且应答顺序正确）”用例；`test_startup_session.py` 等 103 个持久化用例全过（含“删除后草稿被释放且不创建目录”）。
- 管理服务：`service.test.js` 新增 `forgetSession` 正常/忙碌用例。
- CLI 端到端（`frontend-cli/test/agents-delete.test.js`）：真实服务 + 真实宿主 + 真实 Python：
  1. 会话运行中 → `SESSION_BUSY`；
  2. 取消后窗口仍在屏 → `SESSION_OPEN`；
  3. 关闭窗口后删除成功，`home/sessions/<id>` 目录消失，`listSessions {independent:true}` 不再包含，重复删除得到清晰的 `SessionNotFound`。
- 竞态回归：调试中复现的“删除遭遇首次消息材料化 → 目录被重建”场景由 `create_missing/mark_deleted` 修复并测试覆盖。

---

## 5. 【问题 4】Independent 加载策略 —— `3ca13ee`

### 用户需求
“Independent 加载内容太多了，当用户有非常多历史 session 时，机器负载很大。请你更换展示方案，更换更优策略。”

### 根因（实测）
- 管理服务 `independentHistory` 对**每个注册文件夹各发一次** `session/list{workspace_root, limit:100}`，再加一次 `exclude_workspace_roots` 查询（N+1）。
- 运行时 `list_session_metadata` 对**每一条索引记录**做 `realpath` 归一化；实测本机 631 条索引 / 54 个文件夹时，单次文件夹过滤 78.6–93.9ms、exclude 查询 85.6–89.8ms → 一次页面刷新 ≈ **4–5 秒 Python CPU**，且载荷可达 54×100 条会话。

### 依据
- orca `native-chat.ts`：只读“最近窗口”（`DESKTOP_READ_WINDOW = 300`），滚动再加大 `limit` 分页；`transcript-read-cache.ts` 以 **mtime+size** 做解析缓存。
- paperclip：有界渲染 + `staleTime` + 分页（`Issues.tsx` 的 `limit/offset`、`useSharedPolling`）。

### 改动细节
| 层 | 文件 | 改动 |
|----|------|------|
| 运行时 | `agent/infrastructure/persistence/jsonl_session_store.py` | 新增 `list_session_metadata_by_workspace(session_dir, limit, per_workspace_limit, exclude_*：整体一次扫描，按归一化文件夹分组，每文件夹保留最新 N 条，返回 `(sessions, totals)`；`totals` 用“该组最新返回会话的原始 workspace_root”命名（保证是调用方已收到的字符串）。新增模块级 `_normalized_workspace()`，对文件夹 realpath 做**有界记忆化**（≤1024 条，超出清空） |
| 运行时 | `agent/infrastructure/persistence/session_index_repository.py` | `load_index()` 增加按 `(mtime_ns, size)` 的**索引解析缓存**（≤8 个路径）；写路径（`update_index`/`remove_session`）改为在锁内 `_read_index()` 新读，写后 `_invalidate()`，读方得到的一律是只读对象 |
| 运行时 | `agent/runtime/server/session_service.py` / `dispatcher.py` | `session/list` 新增 `per_workspace_limit`（1..20）与 `exclude_session_ids`（字符串数组）；分组查询返回 `totals`，普通查询上限仍为 100、分组查询上限 1000；参数校验与错误信息补齐 |
| 管理服务 | `agent-management/src/history.ts` | `independentHistory` 改为**一次**分组查询：`{per_workspace_limit: 3, limit: 500, exclude_workspace_roots:[manager], exclude_session_ids: 团队会话 id}`；按 `workspaceKey` 分组、跳过团队会话、把 `totals` 映射为 `group.total`。新增 `independentFolder(state, manager, workspace, list)` 供文件夹页按需读取（`workspace_root + limit 100`，同样排除团队会话） |
| 管理服务 | `agent-management/src/ipc.ts` | `listSessions {independent:true}` 支持 `workspace` 参数（文件夹页）；无 `workspace` 时返回分组总览 |
| CLI | `frontend-cli/lib/agents-model.js` | `independentSessions(snapshot, groups, managerPath, folderSessions)`：文件夹页已加载的更全列表替换总览的有界窗口；`independentRows` 的 `sessionCount` 与 “+N more” 改用 `group.total`（真实总数），搜索/筛选态不显示 “more” 行 |
| CLI | `frontend-cli/lib/agents-page.js` | 新增 `view.folderHistory` 与 `loadFolderSessions(workspace)`（进入文件夹页按需加载、30s 过期、删除/重命名会话后清空） |
| 测试 | `test/test_session_listing.py`（新增）、`test/test_runtime_server_protocol.py`、`agent-management/test/history.test.js`、`frontend-cli/test/agents-model.test.js`、`frontend-cli/test/agents-independent.test.js`（新增，真实服务+宿主） | 分组语义、排除顺序、`totals` 命名、索引缓存可见性、文件夹页与总览一致性 |

### 效果（本机实测，631 条索引 / 54 个文件夹）
| 路径 | 修复前 | 修复后 |
|------|--------|--------|
| Independent 总览（Python CPU） | 每文件夹 78.6–93.9ms × N + exclude 85.6–89.8ms ≈ 4–5s | **1 次分组查询：min 15.8ms / avg 17.1ms** |
| 载荷 | 每文件夹至多 100 条（可达 5400 条会话） | 每文件夹 3 条 + 总数 |
| 文件夹页 | 依赖总览里已加载的 100 条 | 打开时按需查询（1 次，7.8–8.2ms） |

CLI 端到端断言：总览每文件夹 ≤3 条、`total` 排除团队会话（含 Manager 文件夹不出现）、文件夹页返回更全列表、重复总览调用耗时上限断言。

---

## 6. 【问题 5】超长会话加载 —— `80bb59a`

### 用户需求
“超长会话加载太慢，更换更优策略。”

### 根因（实测）
- 打开会话时 `session/replay` **全量**返回所有消息（本机最大会话 1602 条、4.5MB JSON）并全量渲染；1602 条会话的 Node 构建 + 虚拟终端全量输出约 450ms，超长会话线性放大。
- Python 侧一次完整 replay 约 250ms（元数据 16.6ms + store 初始化 103ms + 投影 114.5ms + 序列化 20.2ms），全量传输与渲染是主要成本。

### 依据
- codex resume：初始只取最后 5 个 turn（`INITIAL_HISTORY_TURN_LIMIT`），向上滚动再分页取更旧内容。
- opencode TUI：打开会话只取尾部 100 条（`session/messages {limit:100}`），服务端具备游标分页。

### 改动细节
| 层 | 文件 | 改动 |
|----|------|------|
| 运行时 | `agent/runtime/server/session_service.py` | `replay(…, tail=None)`：返回 `messages` 同时给出 `message_total`（总数），`tail` 截取最新 N 条 |
| 运行时 | `agent/runtime/server/worker.py` / `dispatcher.py` | 透传 `tail`；校验 `tail ∈ [1, 5000]` 且与 `start`/`end` 互斥（避免语义歧义） |
| CLI | `frontend-cli/lib/cli-runtime-controller.js` | 恢复/切换会话改为 `{tail: HISTORY_WINDOW}`（= 200 条）；记录 `state.display.history = {sessionId, start, total}`；新增 `/history` 的实现 `runHistoryLoader()`：把更早一页（同样 200 条）载入后**重建转录**，直到 start=0；回合进行中拒绝执行 |
| CLI | `frontend-cli/lib/cli-output-controller.js` | `renderHistory(messages, {notice})`：顶部输出灰色提示（隐藏了多少更早消息 + `/history` 提示） |
| CLI | `frontend-cli/lib/rendering.js` | 新增 `historyTruncatedText(hidden)`（`… 1,302 earlier messages hidden · /history loads more`） |
| CLI | `frontend-cli/lib/command-controller.js` / `local-slash-commands.js` / `frontend-cli-implementation.js` | 注册本地命令 `/history`（非终端环境给出明确说明），接入 runtime controller |
| CLI | `frontend-cli/lib/cli-state.js` | `display.history` 初始为 `null` |
| 文档 | `docs/guide/cheatsheet.md`、`docs/guide/resume.md`、`docs/internals/01-runtime/replay-and-resubscribe.md`（均含 zh-CN） | `/history` 命令、尾部窗口语义、`tail` 协议说明 |

### 测试与证据
- `frontend-cli/test/cli-runtime-controller.test.js`：500 条消息的会话 → 首次恢复只请求 `tail:200`、提示“300 earlier messages hidden”；`/history` 依次 `start:100`、`start:0`，转录重建、提示消失。
- `frontend-cli/test/single-runtime.test.js`：真实宿主 + 真实 Python 的 `session/replay`：`tail:3` 返回最后 3 条与 `message_total:10`；无 `tail` 的调用行为不变。
- Python 协议测试：`tail` 合法/非法/与 start 互斥。

---

## 7. 【问题 6】压缩被自身输入预算拦截 —— `9007509`

### 用户需求
“现在预估超上限好像会拦截压缩。请你借鉴 pi/opencode/codex 的相关的压缩逻辑进行优化。”

### 根因
`CompactionService._prepare_summary_request()` 构造摘要输入（history + retained_recent_messages）后：
1. 只对超长 tool 正文做头/尾各 2000 字符截断；
2. 若估算仍超过 `window − max_output − 5%` 预算，**直接抛 `BoundaryError(code=compact_input_too_large)` 拒绝压缩**——历史越长越无法压缩，形成死锁。

### 依据
- codex `core/src/compact.rs:348-360`：摘要输入超上下文时**从最旧开始逐条删除后重试**，“保持前缀缓存并保留最近消息完整”；删到只剩一条仍超才报错。
- pi `compaction/utils.ts`：摘要输入截断 tool result 到 2000 字符、省略 thinking。
- opencode `session/compaction.ts`：摘要输入保留尾部预算、工具输出截断；摘要请求自身超预算时的失败语义清晰。

### 改动细节
| 文件 | 改动 |
|------|------|
| `agent/application/context/compaction.py` | `_prepare_summary_request()` 重构：`build_request(history_start, dropped_messages)` 可携带被丢弃条数；超预算时先做 tool 正文截断（不变）；仍超则**按“对话单元”从最旧开始丢弃**（每次丢弃约 1/4，单元切分不拆开 assistant tool_calls 与对应 tool 结果），直到装下；丢弃时在 corpus 中写 `note`：「N 条最旧历史未进入摘要、仍在磁盘上、不要声称看过」，避免 handoff 虚报；**至少保留一条消息**（仅剩最新消息仍超预算才拒绝，与 codex 相同） |
| `test/test_compact_budget.py` | 新增：超长历史从最旧端裁剪且其余保留、摘要请求估算确实落入预算；真实会话端到端（8 条超长消息 + 双 recent，window 8192）**压缩成功并落盘 compact_boundary**（修复前必被拒）；原有“不可再缩的单条消息仍拒绝且不改动消息”用例保留 |
| `docs/internals/02-context/compaction-handoff.md` / `.zh-CN.md` | 更新预算预检与丢弃语义 |

### 验证
- `python -m pytest test/test_compact_budget.py test/test_compact_pipeline.py test/test_context_journeys.py`：39 通过。

---

## 8. 【问题 7 + 9】等待语义展示 + 一页纸交付渲染 —— `9f898d2`

### 用户需求
- 问题 7：“主 agent 在等子 agent 的时候加一个等待的语义展示。”
- 问题 9：“一页纸 task 交付内容加强渲染和展示。”

### 根因（三个层次）
1. **宿主工具结果丢了结构**：`agent-management/src/bridge.ts` 输出 `{"ok":true,"result":{...}}`，但运行时 `parse_tool_result_payload` 要求 `ok` 与 `tool` 同时存在，于是被当成“普通文本”再包一层 `tool_ok(name, <字符串>)` → CLI 收到的 `data` 是**二次编码的字符串**；`delegate` 的 `taskId/assignee`、失败信息、模型可见结果全部失真，失败也不会被分类为 failed。
2. **CLI 渲染器按不存在的字段写**：`tool-display.js` 的 delegate 渲染读 `args.agent_id`、`data.agent_id/status/summary/published_paths`；`report`、`agent_management` 没有渲染器。
3. **等待语义缺失**：delegate 是“结束回合、稍后唤醒”的模型，回合结束后 CLI 没有任何“正在等待”的提示；交付回来时以“▷ You 用户消息”的形式出现（实时回合甚至没有内容展示）。

### 依据
- orca 主 agent 等待子 agent 的行状态折叠（`agent-lead-status-fold.ts`：child waiting → 整行 waiting）与“子 agent 诱导的等待”显式建模。
- paperclip Run result 交付卡字段（disposition/summary/verification/remainingWork/artifacts/blocker）与“证据诚实”（无证据要如实标注）。
- codex 状态行语义（`Working`/`Waiting for …`/`Compacting context`）。

### 改动细节
**（a）结构性修复：宿主工具结果遵循运行时契约**
| 文件 | 改动 |
|------|------|
| `agent/infrastructure/tools/external.py` | `_spec.invoke`：`ok:true` → `tool_ok(name, result)`；`ok:false` → `tool_error(name, message, code)`。模型收到的是 `{ok, tool, data:<对象>, ts}`（data 不再是字符串），失败能被 `classify_tool_payload` 正确分类为 failed |
| `test/test_host_tools.py` | 更新成功信封断言；新增“宿主拒绝 → 结构化 tool_error（消息 + 错误码）”用例 |

**（b）等待语义**
| 文件 | 改动 |
|------|------|
| `agent/runtime/server/execution.py` | 交付回合（`delivery=True`）的 `turn_started` 事件带上 `delivery: true` 与 `delivery_text`（该回合就是一次交付） |
| `agent/runtime/core/runtime.py` | `run_turn(..., delivery=True)`：把交付输入以 `meta={"kind":"team_delivery"}` 持久化（交付不是用户手打的，跳过 Skill 解析）；无 meta 时保持原调用形态 |
| `agent/infrastructure/persistence/message_projector.py` | 投影把 `{skill_snapshot, team_delivery}` 的类别透出为 `_rind_meta.kind` |
| `agent/runtime/server/replay_events.py` | durable 事件重建时，`team_delivery` 用户消息同样标记 `delivery/delivery_text`（断线重连后语义一致） |
| `frontend-cli/lib/event-controller.js` | 新增 `pendingDelegations`（taskId → assignee/session）：delegate 成功结果入账；`turn_completed` 时若无后台任务而有待交付 → 输出等待行并**替代**普通 “Worked for” 行；`turn_started.delivery` 时按文本中出现的 taskId 清除等待并渲染交付 |
| `frontend-cli/lib/rendering.js` | `delegatedWaitingLine(names)`：`─ Waiting for reviewer` + “结果会自动送达到本对话，可继续输入”；`deliveryBlockText(text, width)`：`─ Delivery` + 自动换行的交付正文 |

**（c）渲染**
| 文件 | 改动 |
|------|------|
| `frontend-cli/lib/tool-display.js` | 新增 `delegatedTask(result)`（解析新旧两种结果形态：新对象形态与历史里嵌套字符串形态）；重写 `DELEGATE_RENDERER`（运行/完成显示 `delegate → reviewer · task 8f21ab77c3` + brief + 耗时）；新增 `REPORT_RENDERER`（标题 `report → delivered · <outcome>`，body 显示 summary/证据条数/文件名，blocked 形态显示 responder/action）与 `AGENT_MANAGEMENT_RENDERER`（`agent management · snapshot`）；更新折叠/展开上限 |
| `frontend-cli/lib/cli-output-controller.js` | `writeDelivery(text)`；`renderHistory` 识别 `_rind_meta.kind === "team_delivery"` 的用户消息渲染为交付块（不再是 “▷ You”），并在恢复窗口时按历史重建“仍在等待”的行 |
| `frontend-cli/lib/agents-report.js` | 交付报告 Files 行显示文件大小（B/KiB/MiB）；Evidence 为空时如实显示 `none given`；保留 Next 行 |
| `agent-management/src/service.ts` | `resultsText()` 增强为结构化一页纸：`- 成员 · task id · delivered: <outcome>` + `Summary:` + `Evidence:` + `Files (read them with read_file):` + `Next:`（blocked 形态保持） |
| `agent-management/src/tools.ts` | `report` 工具 schema 补上 `nextAction`（Report 模型字段早已支持，只缺声明） |
| `frontend-cli/lib/tour/pages/agents.js` | 教学演示改用真实的 delegate 结果形态 |
| 测试 | `tool-display.test.js`（delegate 新契约、历史兼容、report、agent_management）、`cli-output-controller.test.js`（回放中的交付块与等待行）、`event-controller.test.js`（等待行出现/清除）、`agents-report.test.js`（文件大小、空证据、无文件不显示 Files）、`agent-management/test/rind.test.js`（**全链路 E2E**：真实 leader 会话 → delegate → 成员 report → 交付回到 leader 会话，断言结构化 delegate 结果、`turn_started.delivery_text` 内容、持久化 `_rind_meta`） |
| 文档 | `docs/agents-management.md` / `.zh-CN.md`（交付文本与等待展示）、`docs/internals/05-autonomy/teams.md` / `.zh-CN.md`（交付回合的协议标记） |

### 验证
- `frontend-cli` 相关文件 202 通过；`agent-management` 全套 78 通过（含上述 E2E）；Python `test_host_tools/test_session_delivery/test_runtime_server_protocol` 等 94 通过。

---

## 9. 衍生修复 1：共享宿主不再占用调用方目录 —— `51f07db`

### 背景
引入“共享内核常驻”后，`rind run` 结束宿主仍在运行；若宿主进程的工作目录是调用方目录（Windows 下“进程的当前目录位于某文件夹内”会阻止删除/重命名该文件夹），会在清理与真实使用中造成 `EBUSY`。

### 改动
- `rind-runtime-client/shared-runtime.js`：spawn 宿主时 `cwd: paths.directory`（宿主与它启动的 worker 都落在自己的运行目录，不再持有用户目录）。
- `frontend-cli/test/auth-journey.test.js`：one-shot 与 session-matrix 两个用例在删除临时 home 前先 `removeRindHome`（关闭其启动的共享内核）；工作区冲突断言接受共享路径的等价错误文案。
- `agent/runtime/core/runtime.py`：无 meta 时保持 `persist_user_input(content)` 原调用形态（修复 `test_async_runtime` 暴露的签名差异）。

---

## 10. 衍生修复 2：测试残留清理 —— `32e6d33`

### 背景
全量 CLI 套件每次运行都会在系统临时目录留下 `rind-ipc-home-*`、`rind-one-shot-*`、`rind-prompt-history-*`、`rind-theme-*` 等目录（历史遗留习惯）；配套排查中还清掉了早期失败运行遗留的 36 个运行时进程。为满足“验收/回归不留残留”的要求，补齐四个测试文件的清理。

### 改动
- `frontend-cli/test/ipc.test.js`：模块级 `after()` 删除共享的临时 home。
- `frontend-cli/test/one-shot.test.js`、`prompt-history-store.test.js`、`theme.test.js`：`t.after()` / `finally` 删除各自临时目录（带重试）。

### 验证
- 修改后完整套件运行：运行时进程 0 个、当天临时目录 0 个。

---

## 11. 衍生修复 3：停止中的内核必定停止，卡死的内核可被回收 —— `b6742d8`

### 现场
`rind -c` 报 “Runtime is shutting down.”，该 host 的 Python worker 已死、host 仍在监听且**拒绝包括 `runtime/shutdown` 在内的一切请求**——只能杀进程，即“这个 runtime 就这么难杀吗？”。

### 根因（两处叠加）
1. **`client.shutdown()` 误报**：worker 先退出、确认响应未到达时，`handleExit` 会以 `Runtime exited with N` 拒绝挂起请求；原实现把它当作错误抛出。
2. **宿主 `close()` 中止**：
   - `runtime/shutdown` 处理器里 `await client.shutdown()` 抛出后**跳过了后面的 `close()`**；
   - `close()` 自身是 `closing ||= (async () => { stopping = true; await client.shutdown(); for peers end; server.close… })()`：抛出后被缓存成 **rejected promise**，任何后续调用都不再执行；
   - worker 崩溃触发的 `onExit` 又因 `stopping` 已置位而提前 return（假定别人会收尾）。
   - 结果：`stopping=true`、listener 永远在、端点永远被占。

### 依据
- orca：daemon 生命周期“先停服务、再停 worker、最后离开”；`daemon-stale-kill.ts` 对“健康检查失败且证明无 live session”的陈旧 daemon 进行终止；`daemon-pid-identity.ts` 的 pid 记录用于证明与击杀。

### 改动细节
| 文件 | 改动 |
|------|------|
| `rind-runtime-client/runtime-client.js` | `shutdown()`：子进程**干净退出（code 0）即视为关闭成功**，即使确认响应与退出竞争、或请求被拒；非 0 退出才优先抛出请求错误，否则抛退出错误 |
| `rind-runtime-client/shared-server.js` | ① `runtime/shutdown` 处理器：`client.shutdown()` 的错误只写 stderr（runtime.log），**随后必定** `peer.send({stopped:true})` 并 `await close()`；② `close()` 重写为“必定完成”：先 `server.close()`（立即释放端点名字，新宿主可马上绑定）→ peers `end()`（1s 后强制 destroy 兜底）→ `await client.shutdown()`（异常忽略）→ `client.forceShutdown()` → `await closed` → 释放 pid 记录 → 宿主入口 `process.exit(0)`；③ 启动成功后发布 `runtime/host.json`（`{pid, nonce, startedAt}`，0600），关闭时按 nonce 校验后删除（绝不删后来者的记录） |
| `rind-runtime-client/shared-runtime.js` | ① `sharedRuntimePaths` 增加 `record`；② `checked()` 的健康探测**限时 3 秒**（防止“只应答 TCP、不回协议”的宿主把窗口挂满 120s）；探测失败视为“不能用的宿主”：先等端点释放，再按 pid 记录结束卡死宿主；③ 新增 `takeOverStuckEndpoint()`（启动路径同样处理“端点被占但无可用主机”）、`waitForFreeEndpoint()`、`endStuckHost()`、`delay()` |
| `rind-runtime-client/endpoint.js` | 导出 `probeEndpoint`（端点存活探测），供上述回收逻辑复用 |
| `agent-management/src/ipc.ts` | 管理服务 `close()` 用 `finally` 保证 `runtime.close + sockets.destroy + server.close` 一定执行 |
| `frontend-cli/test/single-runtime.test.js` | 新增两个 E2E：① worker 在关闭途中死亡 → host 约 60ms 内退出、端点立即释放、新窗口 130ms 内起新宿主；② 伪造“占着端点不应答”的进程 + pid 记录 → 客户端结束它并成功启动真宿主 |

### 验证（实测）
- 修复前：host 存活 ≥12s、端点被占、`runtime/shutdown` 被拒；修复后：`runtime/shutdown` 确认 `{stopped:true}`、host 约 60ms 退出、端点立即释放、重启约 130ms。
- 用户现场遗留的僵尸 host（pid 22000）已确认同样症状并清除；排查确认真实 home 上其它进程属于用户自己当时的两个 `rind -c` 窗口（两窗口共用 1 host + 1 worker），未做打扰。

---

## 12. 仓库卫生 —— `1488650`
- `.gitignore` 增加 `/.e2e/`（用户私有端到端验收目录），不进入版本库。

---

## 13. 验证汇总

### 13.1 测试结果（最终状态）

| 套件 | 命令 | 结果 |
|------|------|------|
| Python 运行时 | `python -m pytest test/ -q --ignore=test/benchmarks` | **1512 通过**；1 failed + 2 errors 为**基线既有**问题（`test_tool_result_normalizer.py`，Windows 环境变量长度限制；在基线 worktree `9e9d8e6` 上复现完全相同的 1 failed / 17 passed / 2 errors） |
| CLI | `npm --prefix frontend-cli test` | **679 个测试：677 通过 / 0 失败 / 2 跳过**（跳过项为 Unix 专属的端点所有权分支与另一项平台用例） |
| 管理服务 | `npm --prefix agent-management test` | **78 通过 / 0 失败**（build + 含真实进程 E2E） |
| Web 前端 | `npm --prefix frontend-web test` | **386 通过 / 0 失败** |

### 13.2 新增的端到端测试（真实进程/真实服务，用户视角）

| 文件 | 场景 |
|------|------|
| `frontend-cli/test/single-runtime.test.js` | 并发启动收敛为一个 host+worker；陈旧锁回收；端点占用拒绝；`rind run` 两次复用同一 worker 且宿主常驻；`rind send` 不启动内核；management 与 runtime pid/startedAt 一致；replay 尾部窗口；**worker 死亡后宿主必定退出**；**卡死宿主被 pid 记录回收** |
| `frontend-cli/test/agents-delete.test.js` | 运行中/在屏时拒绝删除；关闭窗口后删除成功、目录消失、列表同步、重复删除报 `SessionNotFound` |
| `frontend-cli/test/agents-independent.test.js` | 单次分组查询、每文件夹 ≤3 条、`total` 排除团队会话、Manager 文件夹不出现、文件夹页更全、重复加载耗时上限 |
| `frontend-cli/test/agents-lifecycle.test.js`（新增用例） | 全新 home 中在 Manager 文件夹直接进入 → 与 Agents 页一致的 Manager 会话/工具/注册 |
| `frontend-cli/test/endpoint-ownership.test.js` | 活宿主拒绝第二 server；Unix：死条目被原子替换（Windows 跳过） |
| `agent-management/test/rind.test.js`（新增用例） | leader 会话 delegate → 成员 report → 交付作为 leader 会话的下一回合回来（结构化结果 + `delivery_text` + `_rind_meta`） |

### 13.3 性能数据

| 项 | 修复前 | 修复后 |
|----|--------|--------|
| Independent 总览（631 条索引 / 54 文件夹） | ≈ 4–5 s Python CPU/次，N+1 查询 | 单次查询 15.8–17.1 ms |
| 索引重复读取 | 每次全量 JSON 解析（≈14–16ms/次） | 按 mtime+size 缓存命中 |
| 打开 1602 条消息的会话 | 全量传输 4.5MB + 全量渲染（约 450ms 渲染 + 250ms Python） | 尾部 200 条窗口 + `/history` 按需分页 |
| 超预算压缩 | 直接拒绝（`compact_input_too_large`） | 从最旧裁剪直到可压缩，真实会话端到端成功落盘 |
| 关闭中的内核 | 可能残留、拒绝一切请求 | 必定退出（实测 ~60ms）、端点立即释放 |

---

## 14. 兼容性、行为变化与限制

### 协议新增（均为向后兼容的增量）
- `session/list`：`per_workspace_limit`、`exclude_session_ids`；响应新增 `totals`（仅分组查询）。
- `session/replay`：`tail`（与 `start`/`end` 互斥）；响应新增 `message_total`。
- `session/delete`：删除成功后广播 `session_deleted`；用户消息新增 `meta.kind = "team_delivery"`，投影透出 `_rind_meta`。
- `turn_started`：交付回合新增 `delivery`、`delivery_text`。
- 宿主工具结果：`data` 从“二次编码字符串”变为结构化对象（这是对既有契约的修正；模型与 CLI 同时受益）。
- 新增运行时文件：`RIND_HOME/runtime/host.json`（pid 记录，仅用于回收卡死宿主）。

### 行为变化（有意为之）
1. `rind run` 与窗口共用内核，运行结束后宿主常驻（`--trace-llm`/`--session-dir` 仍私有）；停止用 Background 页或 `rind agents stop`。
2. `/model` 不再显示未配置凭证的 provider（含过期当前选择）。
3. Agents 页可删除会话，删除不可恢复（消息永久移除，产物文件保留）；有窗口在屏或任务运行时拒绝。
4. 打开长会话默认只显示尾部 200 条，更早内容用 `/history` 逐页加载。
5. 超长历史压缩会丢弃最旧单元（corpus 内注明，磁盘原文保留；这是 codex 同款取舍），仅“仅剩最新消息仍超预算”才拒绝。

### 未覆盖 / 后续建议
- 跳过 2 项测试：Unix 端点所有权分支在 Windows 跳过（Linux CI 覆盖）；另一项为既有平台跳过。
- `test_tool_result_normalizer.py` 的 1 failed + 2 errors 为基线既有 Windows 环境问题，非本轮引入。
- 按仓库策略未执行 `test/manual/` 的用户场景验收（未消耗真实模型）。
- `desktop`/`mobile`/`frontend-web` 的 delegate/report 渲染仍沿用旧字段名（修复前后同样取不到新增字段，无回归）；如需与 CLI 对齐可后续用同一契约补渲染。
- 压缩的 LLM 摘要输入在极端超长时会丢最旧历史（有 note 标记）；如需更强保真可后续把确定性 handoff 作为附录拼入摘要。

---

## 附录 A：提交清单（按时间顺序）

```
1488650 chore: ignore private e2e acceptance directory
1bcef3e fix(models): list only connections that are configured
fd02f97 fix(agents): the Manager's folder is the Manager, however you enter it
1f1e463 fix(runtime): one host and one worker for every entry point
bb43a01 feat(agents): delete a conversation from Agents management
3ca13ee perf(agents): one bounded page per folder for Independent
80bb59a perf(cli): open long conversations on their newest messages with /history paging
9007509 fix(context): compact an over-budget history instead of refusing
9f898d2 feat(cli): show waiting on delegated work and render deliveries as reports
51f07db fix(runtime): keep the shared host out of the caller's folder
32e6d33 test: remove the temporary homes the CLI tests create
b6742d8 fix(runtime): a stopping Runtime always stops, and a stuck one can be ended
```

## 附录 B：新增文件

| 文件 | 用途 |
|------|------|
| `rind-runtime-client/endpoint.js` | 排他端点发布协议（bind/link/rename）+ `probeEndpoint` |
| `frontend-cli/test/single-runtime.test.js` | 单内核与宿主生命周期的进程级 E2E |
| `frontend-cli/test/endpoint-ownership.test.js` | 端点所有权协议单测（Unix 分支） |
| `frontend-cli/test/agents-delete.test.js` | 会话删除 E2E |
| `frontend-cli/test/agents-independent.test.js` | Independent 有界加载 E2E |
| `test/test_session_listing.py` | 分组列表、totals、索引缓存单测 |

## 附录 C：文档更新清单

- `docs/agents-management.md` / `.zh-CN.md`：Manager 身份、单宿主启动/停止语义、会话删除、Independent 加载、交付等待与展示
- `docs/internals/01-runtime/replay-and-resubscribe.md` / `.zh-CN.md`：`tail` 与 `message_total`
- `docs/internals/02-context/compaction-handoff.md` / `.zh-CN.md`：超预算裁剪
- `docs/internals/05-autonomy/teams.md` / `.zh-CN.md`：交付回合标记
- `docs/internals/06-models/model-catalog.md` / `.zh-CN.md`：凭证过滤
- `docs/internals/07-surfaces/one-shot.md` / `.zh-CN.md`：共享内核语义
- `docs/guide/cheatsheet.md` / `.zh-CN.md`、`docs/guide/resume.md` / `.zh-CN.md`：`/history`
