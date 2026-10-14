# 9e9d8e6 后变更的独立审阅与修复

日期：2026-10-14。分支：`perf/context-efficiency`。原始审阅范围：`9e9d8e6..aedd397`，共 13 个提交，其中 12 个代码/配置提交、1 个原变更报告提交。代码修复终点：`4294831`。

## 1. 结论与审阅方法

优化方向基本合理，但原实现存在确定的全局边界缺口，不能据原报告认定已经闭合。主要问题是：缓存没有进入生产调用链；有界列表没有完整的继续访问入口；尾部回放遗漏委派状态；删除只处理了部分客户端身份；压缩为了满足预算丢弃过多仍可容纳的上下文；宿主接管和退出存在所有权竞态。

本次逐一检查原提交 diff，并沿生产调用链检查 Python runtime/persistence/context、共享 Node host/client、management IPC、CLI 和 Web/Desktop 消费者，结合新增回归复现并修正。保留现有模块和协议，没有引入新的后台服务、数据库或通用状态框架。修复按主题提交，未推送远端。

审阅同时阅读 `.docs/performance-optimization.md`、`token-cost-optimization-round2.md`、`token-cost-optimization-round3.md`、`perf-context-efficiency-fixes.md`。其中许多实现和上一轮修复已在本次基线之前，不能重复计为这 13 个提交的收益。三轮文档中的金额、排名、命中率和成本预测属于历史记录，本次没有真实模型复测予以认证。

## 2. 原提交逐项判断

| 提交 | 判断 | 独立核查结果 |
| --- | --- | --- |
| `1488650` | 合理 | 忽略私有验收目录；自动回归与用户场景验收仍按仓库测试政策分开。 |
| `1bcef3e` | 合理 | 配置/凭证来源与模型菜单补入条件一致，避免把已登出的 provider 重新补回。未发现本轮新增的确定缺陷。 |
| `fd02f97` | 合理 | Manager 工作目录身份集中解析，不依赖进入界面的位置。已检查管理入口及会话绑定路径。 |
| `1f1e463` | 方向合理，需修正 | 统一共享宿主减少重复进程，但启动锁、删除与打开交错、Worker 退出前释放端点等边界没有闭合。见 R7–R9。 |
| `bb43a01` | 功能合理，需补全 | 磁盘删除不足以清理窗口保留身份和 management 注册；下一次首条消息可能沿用被删身份或旧授权 token。见 R6。 |
| `3ca13ee` | 原实现不完整 | 首批 preview 之外的文件夹消失；文件夹内超过 100 个会话缺少完整可达路径。见 R2。 |
| `80bb59a` | 方向合理，需修正 | tail 能减少传输/首屏渲染，但 range 总数错误，翻页晚响应可覆盖新输出，tail 不能独立恢复完整委派状态。见 R3、R5。 |
| `9007509` | 必须修正 | 以 25% 为批次丢历史会多丢仍放得下的近期约束；丢弃文本后仍可能携带老图片附件。见 R4。 |
| `9f898d2` | 展示方向合理，状态处理不完整 | pending 集合与历史回放分叉，正文引用 task ID 会误清其它任务，失败/取消和多前端字段消费不一致。见 R5。 |
| `51f07db` | 合理，需补全路径边界 | detached cwd 移出用户项目正确，但调用方的相对 repo/runtime/python 路径必须先解析。见 R7。 |
| `32e6d33` | 合理 | 测试应释放自己创建的进程和临时 home；新回归继续遵守这一约束。 |
| `b6742d8` | 必须加强所有权校验 | PID 记录和不响应端点不能直接授权杀进程；还需操作系统命令行身份、nonce、记录复查和健康重查。见 R7–R9。 |
| `aedd397` | 报告需要纠偏 | 报告正文范围止于 `b6742d8`，没有证明上述全局边界，也高估了部分缓存/分页优化的实际覆盖。原文保留为历史记录，并链接本报告。 |

## 3. 已修复的问题与回归证据

P1 表示会丢失上下文/功能可达性、错误覆盖状态，或影响运行时所有权；P2 表示统计、兼容性或恢复展示问题。

### R1：索引缓存未进入生产路径（P2）

原扫描仍直接读取索引，既有 repository cache 没有服务真实列表调用。已让生产 scan 使用 `SessionIndexRepository.load_index`；writer 在锁内 fresh read 并失效缓存。缓存签名包含 dev/ino/ctime_ns/mtime_ns/size，读取前后签名一致才缓存，返回值独立复制。永久 workspace 解析 memo 改为单次 scan 内缓存，避免符号链接变化后长期使用旧路径。

`test/test_session_listing.py` 新增生产路径读取复用、同大小且同 mtime 的原子替换等回归。收益是避免不必要的重复 JSON 读取/解析；列表仍有全量过滤、复制和排序，不能称为常数时间列表。

### R2：限制首批数量导致会话和文件夹不可达（P1）

原 grouped preview 最多 500 项，management 据 preview 建文件夹，导致其外文件夹消失。现在先据完整 totals 建立文件夹，再补 preview。文件夹内每次获取 100 项，通过 `excludeSessionIds` 排除 team 和已经加载的会话；IPC 严格校验 string 数组，CLI 增加可键盘进入的 “Load earlier” 行和 loading guard。

管理推送刷新不会把已翻到的多页悄悄重置成第一页；显式 `r` 刷新才重置。搜索提示限定为已加载会话。分页失败保留已加载数据。

证据：Python 覆盖 preview 500 项之外的文件夹 totals；management history 测试覆盖排除后继续分页；CLI 用 205 个会话、真实 IPC/Python 和虚拟终端键盘翻到最旧会话，检查管理推送保页与 `r` 重置。这些进程使用隔离数据，不调用模型。

### R3：历史总数和晚返回覆盖（P1/P2）

原 `start/end` 范围回放把窗口长度当作完整总数。现在先计算完整 `message_total` 再切窗口，tail/range 共享总数语义。grouped 列表与 workspace filter 的不兼容组合明确报错，避免静默忽略 filter。

`/history` 等待前记录 session、history 对象、event sequence 和最后 turn；响应回来后检查它们仍有效，再重建 transcript。普通初始 restore 也使用 generation 检查；删除和更新的切换会使旧响应失效。新增回归覆盖删除中 restore、新切换胜过旧 restore，以及 session/turn/history/完成 turn/event sequence 变化后的翻页响应。

验证范围是上述确定竞态；本次没有证明 replay 快照与同会话持续流式事件之间具有全局原子一致性，见第 6 节。

### R4：预算裁剪过粗并残留已丢弃图片（P1）

一个超大的最旧历史 unit 即可引发原算法再丢后面 25% 的内容，近期用户约束因此无谓消失。现在按完整 unit 切点估算所需裁剪量，以实际最终 request 预算校验，并尝试恢复仍能容纳的完整 unit。工具调用与结果保持完整 unit。图片上限变化会影响 vision/text 请求，恢复时逐个检查实际 request，避免假定预算严格单调。

附件从真正保留的 corpus 收集，丢弃历史图片的同时丢弃其附件。`test/test_compact_budget.py` 覆盖超大最旧 unit 后仍保留可容纳的 20 条约束，以及裁剪图片后请求不携带老附件。

本地无 provider microbenchmark：1000 条消息约 1152 次估算/1.112 秒，2000 条约 2317 次/2.624 秒，启用 tokenizer。这仅是特定输入的本地耗时，不能证明所有输入严格线性，也不能证明真实模型摘要质量。

### R5：委派等待状态与展示投影不一致（P1/P2）

live/history 共用 `delegation-state.js` 和 pending Map。只解析宿主交付 heading 中的 task ID，正文引用其它 task ID 不再误清任务。`ok:false` 不计为成功委派，cancelled 清理 pending；queued/active cancellation 结果补齐消费者需要的 assignee/taskId/status。

tail 可能看不到最早的 delegate 调用，因此增加 management `pendingDelegations`：由完整 user snapshot 按 originSessionId、未 returned、非 cancelled 推导，恢复等待状态。快照读取前后检测 runtime event sequence，变化时不拿旧 management 快照覆盖状态。Web/Desktop 按真实 `to/new.name/brief/message/task/assignee/taskId` 字段投影，保留既有兼容输入；Mobile 复用 Web。

证据：CLI live/history 对称测试、失败/取消/正文引用测试；真实 management 集成以 `start:false` 分派任务，验证待交付恢复和取消后的空集合；Web 工具显示 30 项与 Desktop 工具显示 20 项回归。

### R6：删除后仍保留旧身份和授权绑定（P1）

删除当前会话清理 reserved ID、名称/skills 草稿、history、等待/stats、pending、输入、transcript、turn 与 compact 活动状态。Python 删除草稿始终清 `_created`，重复删除不再虚报成功。

新建会话重新 attach management；合并并发 attach，close 等待进行中的 attach，失败时 detach。externalTools 在原对象上更新 token，既有引用收到新授权，不留下旧 token。

证据：真实隔离 fake 环境删除旧会话后，新建 ID/token、scoped 授权可用、只有一个 registration；CLI 验证删除活动状态后首条消息没有携带旧 reserved ID。

### R7：宿主启动、身份和路径边界（P1）

调用方相对路径先绝对化，detached host 再使用 home/runtime cwd。connect 有 3 秒超时，失败清连接和 timer。stuck kill 要求合法 PID、alive、操作系统命令行匹配 host entry/UUID nonce、记录未变并再次检查健康；无法证明身份时拒杀。只有 ESRCH 证明进程已死，权限错误不等于死亡。

回归包含旧 PID 记录指向无关端点进程时拒绝击杀；测试 nonce 使用合法 UUID，确保实际经过 OS 身份校验分支，而非只被格式校验提前拦截。未干扰用户已有会话或宿主。

### R8：启动锁与 Unix 发布竞态（P1）

旧 stat/rename 锁回收可与新 owner 竞争。改用共享 `process-lock.js`：mkdir 独占，PID+UUID 的唯一 marker；只有成功删除死 owner marker 的 actor 才能删除目录。重复 release 不会删除继任者的锁。空/异常锁 ownership unknown，超时报告路径，不按年龄删除。

Unix endpoint 发布在同一 process lock 下 probe/link/rename；只有 ENOENT/ECONNREFUSED 证明端点空闲，未知错误保守占用，发布失败关闭私有 listener。Windows 使用独占 named pipe。该发布保证针对遵循协议的 Rind publishers，不宣称能与任意外部软件完成原子 CAS。

最终 CLI 全量回归曾真实触发 Windows 多进程回收死锁时 `unlink EPERM`。增加仅 Windows sharing violation 的有界重试，始终重试同一唯一 marker，只有成功 unlink 者删除目录。修复后独立进程竞争测试连续执行 10 轮通过，每轮 8 个进程争抢预置死锁，enter/exit 成对，重复释放无误、目录清理完成。

### R9：退出和删除/打开交错（P1）

共享 server 的 create/open/subscribe/prompt/compact/delete 在首个 await 前登记 opening/deleting，封闭删除与新进入之间的窗口。退出先结束 Worker，再释放 endpoint，防止新 host 与旧 Worker 清理重叠。runtime client shutdown 同时处理已设置 exitCode/signalCode 的 child，避免错过 exit 后等待不结束。

证据为 single-runtime、runtime-client、删除集成等确定性真实进程回归。Unix endpoint 相关分支在本机 Windows 被跳过，不能计为已经执行的 Unix 验证。

### R10：已有测试在 Windows 的可执行性（P2）

巨大参数被 pytest 自动展开为 test ID，导致 `PYTEST_CURRENT_TEST` 超过 Windows 环境变量长度限制；另有默认编码读取 UTF-8 文件失败。基线核查确认是既有测试问题。改用短 ids 和显式 UTF-8；未修改对应 normalizer 生产逻辑，也未通过放宽断言规避失败。

## 4. 上游源码核查

本次核查使用本地 `E:/code/agent1/<仓库>`，冻结版本如下。借鉴原则需要结合 Rind 的存储与协议验证，引用上游并不能替代本项目回归。

| 仓库/HEAD | 实际阅读的实现 | 对 Rind 的边界判断 |
| --- | --- | --- |
| opencode `cfa134f042151877c03222f34a7bdba2c770609b` | `packages/opencode/src/session/message-v2.ts` 的 limit+1/time/id cursor | 上游有数据库分页；Rind JSONL replay 全读投影再切窗口，不能声称具有相同磁盘成本。 |
| pi `3daa20280f6a7c7cbe0935680c9a38fdc3863005` | `packages/coding-agent/src/core/compaction/compaction.ts` valid cut points；`utils.ts` 工具内容限长 | 应按合法边界保留工具配对，限长必须和完整业务记录分开；本轮修复不削减已有工具能力。 |
| codex `7d0b91d5d686688893fecb356e27fdebaad66ee1` | `codex-rs/core/src/compact.rs` 的 `history.remove_first_item()` | 逐项移除最旧内容与 Rind 原 25% 批量丢弃不是等价实现；本轮改为完整 unit 的细粒度边界。 |
| orca `7ed23199a5aa2b41ea52beccaf1cf0fbf6d3828e` | `src/main/daemon/daemon-pid-identity.ts`、`daemon-endpoint-ownership.ts` | 操作系统身份与 unknown/dead 区分是必要边界；Rind 采用自己可验证的 entry+nonce，不伪称完整移植上游身份机制。 |
| paperclip `721e87ac029b5b065910e2cc1a9f767810fcce66` | `ui/src/components/task-chat/TaskChatProtocolCard.tsx` 的 ResultCard | 借鉴 summary/disposition/verification/remainingWork/artifacts/blocker 展示；展示正文不能成为 authoritative task state。 |

## 5. Git 与验证

| 修复提交 | 主题 |
| --- | --- |
| `ff46030` | 生产索引缓存、回放 totals、压缩预算与附件 |
| `4c80ef3` | 全部 Independent 文件夹与历史页可达 |
| `dfb2f51` | host/endpoint 所有权、退出顺序、路径与进程身份 |
| `cae8602` | 委派权威恢复、取消与删除后重新绑定、多前端投影 |
| `31a52bb` | 删除/切换使晚到 restore 响应失效 |
| `8d34b7d` | 删除后活动状态清理、加强 OS 身份回归 |
| `4294831` | Windows 共享删除冲突的有界重试 |

使用 Python `C:/Users/admin/miniconda3/python.exe`；CLI 测试显式设置 `RIND_PYTHON`。测试子进程移除环境中的 `NO_COLOR=1`，使已有 ANSI 断言按其测试契约运行；没有修改用户持久设置。

| 检查 | 结果与范围 |
| --- | --- |
| `python -m pytest test -q --ignore=test/manual` | 1520 passed，3 skipped。覆盖全部 Python 生产改动。 |
| `npm --prefix frontend-cli test` | 最终 694 passed，2 skipped，0 failed（696 项，67.63 秒）；包括最新恢复/删除回归和 process lock 修复。 |
| `npm --prefix agent-management test` | 80 passed；在最终 Windows 锁重试前执行，之后未修改 management 代码；共享锁最终由 CLI 全量覆盖。 |
| Web 全量 | 改动前 43 files / 386 passed；本轮 Web 最后改动后相关 toolDisplay 定向 30 passed。不把早期全量当作最终代码的全量结果。 |
| Desktop | 改动后工具显示 20 passed，`tsc --noEmit` 通过。 |
| 额外边界验证 | 恢复/删除/无关端点 PID 10 passed；Windows process lock 连续 10 轮、每轮 3 passed。 |

这些是 mock、本地 fake provider 和确定性进程级自动回归。真实进程不等于真实模型通过；未执行 `test/manual`、真实 provider、真实计费基准或用户终端验收。

## 6. 明确保留的限制

- JSONL 历史仍先全量读取/投影，再选 tail/range；`/history` 重建累计显示窗口。收益主要是首屏传输和渲染量，超长会话仍有读取成本。
- 索引 cache 不能消除全量过滤、复制和排序；未引入数据库或额外常驻索引服务。
- 压缩 suffix 恢复在极端分布下仍可能有较高计算成本，本地样例不构成复杂度或真实摘要质量保证。
- 本机为 Windows，没有执行 Unix socket 接管路径；需在 Unix CI/环境运行已有分支测试才有实测证据。
- mkdir 后、marker 写入前崩溃，或删除 marker 后、rmdir 前崩溃，可能留下空锁。为避免误删活 owner 的极短窗口，空锁保守超时；确认无 owner 后才能人工清理报错路径。PID 重用也采用保守等待。
- stuck-host 回归没有证明“已启动 Python Worker 后强杀 Node”在所有平台绝无孤儿进程；不能据此作该承诺。
- 基线已存在 replay/live stream 快照一致性问题的可能性。本轮证明并修复的是具体 generation 与翻页覆盖竞态，未建立 snapshot watermark/流式事件缓冲协议；不声称恢复所有时序均全局原子。持续流式时 management 快照失效会回退到历史重建，tail 之外委派的恢复也不能由该回退单独保证。

## 7. 清理

测试使用隔离临时目录及 home，拥有的子进程由夹具退出/终止，未停止用户已有 OpenCode/Rind 进程。核查 TEMP 中 `rind-agents-paging-*`、`rind-process-lock-*`、`rind-dead-lock-*`、`rind-unknown-lock-*`、`rind-delete-managed-*` 无目录残留；按这些隔离路径检查 node/python 进程，无匹配进程。回归结果记录到本报告后删除本轮明确命名的临时日志；不保留测试凭据或会话数据，不删除用户已有 `.docs` 产物。
