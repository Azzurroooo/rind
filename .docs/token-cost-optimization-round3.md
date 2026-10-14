# Rind Token 成本优化方案（第三轮）：固定前缀经济性

> **2026-10-13 修复后状态**：本文保留本轮的历史测量与方案；金额、排名、预测和旧测试计数不代表修复后的验收结果。当前实现、固定版本的上游源码依据及全量测试见 [修复报告](perf-context-efficiency-fixes.md)。本次未复跑真实计费模型基准。

> 上一轮：[token-cost-optimization-round2.md](./token-cost-optimization-round2.md) · 第一轮：[performance-optimization.md](./performance-optimization.md)
>
> **前两轮成果：未命中 2,667 → 1,329（−50.2%），命中率 90.7% → 94.7%，成本 $0.00202 → $0.00146（−27.5%），排名第 2（超过 opencode/codex，仅次于 pi）。**
>
> **本轮结论：与 pi 剩余的 $0.00011/次差距，全部在输入侧的固定前缀——rind 每次请求 5,340 tokens，pi 2,462（2.2 倍）。逐段量化后，其中约 1,800 tokens 是「与工具 schema 逐句重复的说明」或「当前未启用能力的说明」。去重目标是保留能力与政策，但初版误删了独有的不可信输出规则，已在本次修复恢复。每次再省 $0.00005–0.00006、落到 $0.00140 是历史预测，本次没有真实模型复测来认证。**

---

## 0. 本轮明确不做的事（依据）

| 不做 | 依据 |
|---|---|
| 不收紧工具输出上限 | rind 模型侧 25KB/2000 行；pi 的 bash 是 50KB/2000 行（`tools/truncate.ts`）——rind 已经更紧 |
| 不压缩推理 | pi 显式回放 thinking 为 `reasoning_content`（`api/openai-completions.ts::convertMessages`），三家主循环都不降档 |
| 不删历史工具结果 | codex `context_manager/normalize.rs` 只做 `ensure_call_outputs_present`、`remove_orphan_outputs`、`strip_images_when_unsupported` |
| 不动输出侧 | rind 输出 768 tokens/次，已低于 pi 806 / opencode 806；构成（推理 55% / 工具参数 36% / 正文 9%）与三家同级，且三家都没有压缩机制 |
| 不用"少给上下文"式裁剪 | 目标为只去重复；初版独有 trust 规则被误删，本次已恢复，必须验证行为与政策的等价承载 |

---

## 1. 本轮新增的测量

### 1.1 每次请求的固定前缀（tiktoken，取真实构建产物）

| 区块 | tokens | 说明 |
|---|---|---|
| `system[0]` 模板 | **2,013** | 见 1.2 逐段 |
| 环境块（尾随） | ~90 | 必需 |
| `system[1]` tool_guidance | 139 | 仅 `ask_user_question` 存在时 |
| `system[2]` goal_policy | 135 | **恒定注入**，与是否有活跃 goal 无关 |
| skill_catalog | 143 | 有技能时 |
| tools（13 个 schema） | **2,181** | 见 1.3 |
| **合计** | **≈4,700** | 对照：pi 的 system+tools ≈ 1,515 |

### 1.2 系统提示逐段与"重复/未使用"定位

| 小节 | tokens | 判定 |
|---|---|---|
| preamble | 31 | 保留 |
| `FILE_TOOL_RULES` | 182 | **与 read/write/edit 的 schema 描述逐句重复**（见 1.4 引文） |
| Code Search & Navigation | 73 | 与 glob/grep 描述重复 |
| System Execution | 200 | 与 bash/task_control 描述重复 |
| Internet Access | 45 | 与 search_web/fetch_web_page 描述重复 |
| Plan Management | 130 | 与 update_plan 描述重复 |
| Path Resolution | 109 | 独有（cwd 语义）→ 保留 |
| **Mandatory Planning Protocol** | 280 | 一半与 update_plan 描述重复，一半是"何时规划"（保留） |
| Execution Loop | 187 | 与 core_capabilities 重复 |
| Tool Best Practices | 256 | 与 core_capabilities 重复；"读取体积规则 / 并行调用"独有（保留） |
| Safety Protocols | 131 | 独有 → 保留 |
| Communication Style | 126 | 独有 → 保留 |
| Plan Data Integrity | 50 | 与 update_plan 描述重复 |
| Skill Usage | 75 | 独有 → 保留 |
| RIND.md Context Docs | 104 | 独有 → 保留 |

可删合计：182−30 + 73 + 200−60 + 45 + 130 + 280−80 + 187 + 256−80 + 50 ≈ **−1,150 tokens/请求**

### 1.3 历史候选工具估算（不是最终实际广告集合）

原统计包含 main 已不广告的 bash_output，不能将 2,181 或合计约 4,700 tokens 直接用作真实请求基线，也不能重复计算隐藏它的收益。glob / grep 的可选隐藏最终未采纳。

| tool | tokens | desc | params | 备注 |
|---|---|---|---|---|
| task_control | 280 | 55 | 201 | 核心（异步任务模型） |
| bash | 259 | 116 | 120 | 核心 |
| ask_user_question | 226 | 45 | 156 | 交互式才有；一行版 `rind run` 已用 `--no-user-question` 关闭 |
| read_file | 221 | 83 | 114 | 核心 |
| update_plan | 208 | 72 | 112 | 核心 |
| grep | 187 | 26 | 138 | **pi 默认不 advertise（搜索走 bash）** |
| glob | 148 | 23 | 102 | 同上 |
| edit_file | 133 | 17 | 92 | 核心 |
| bash_output | **120** | 21 | 75 | main 已 advertised=False；不计新增收益 |
| search_web | 120 | 31 | 65 | 能力，非本轮目标 |
| write_file | 101 | 22 | 55 | 核心 |
| update_goal | 90 | 23 | 43 | 与 goal_policy 同属按需能力 |
| fetch_web_page | 88 | 30 | 33 | 能力 |

### 1.4 上游做法（改动依据）

| 依据 | 位置 | 事实 |
|---|---|---|
| pi：工具默认只有 4 个 | `core/system-prompt.ts::normalizeBuildSystemPromptOptions` | `selectedTools ?? ["read","bash","edit","write"]`；grep/find/ls 是**存在但不默认选中**的工具 |
| pi：搜索走 bash 且规则明示 | `core/system-prompt.ts::buildRules` | `"Use bash for file operations like ls, rg, find"` |
| pi：工具说明随工具走 | 同上 + 各 `tools/*.ts` | `toolSnippets` / `toolGuidelines` 由**每个工具自己贡献**，只为选中的工具渲染 |
| pi：可隐藏工具 | `BuildSystemPromptOptions.hiddenTools` | "Selected tools whose declarations requests leave out (prepareLoadout hidden declarations)" |
| opencode：只为存在的工具渲染指引 | `session/system-prompt.ts::render` | `if (tools.includes("shell")) …`、`if (tools.includes("edit")) …` |
| opencode：指引随能力出现/消失 | `*/instructions.ts` + `session/context.ts` | 每个能力有 `initial/changed/removed` 渲染；标题等辅助调用用最小模型 |
| codex：模型侧只给输出文本 | `core/src/tools/mod.rs::format_exec_output_str` | "Truncate for model consumption before serialization" |

**rind 现状的对应物**：`agent/prompts.py` 的 `_SYSTEM_PROMPT_TEMPLATE` 把工具说明写死在模板里（无法按工具条件化），而工具自己的 schema 已经完整描述了同一件事——两侧都写，模型两次收到。

### 1.5 未命中不是本轮主因

| agent | 每轮新增内容（字符中位） | 未命中/轮 中位 | p90 |
|---|---|---|---|
| rind | 916 | 234 | 634 |
| pi | 790 | 227 | 417 |
| opencode | 669 | 212 | 285 |

rind 的未命中与新增内容成比例（0.26 tokens/字符），p90 偏高来自模型自己发出的多命令 bash（行为，不是固定开销）。→ 未命中侧没有"清理型"改动可做，不列为本轮目标。

---

## 2. 改动清单（每条都有上游依据）

### P0 系统提示与工具 schema 去重（−1,150 tokens/请求）

去重必须确认对应工具 schema 或保留的政策仍承载原信息。下表仅验证部分重复工具说明，未覆盖初版误删的 trust 规则；该规则已单独恢复并加回归验证。例如：

| 系统提示（删） | 工具 schema（留） |
|---|---|
| "`write_file`: Atomically create or completely overwrite a UTF-8 text file. Use for new files or complete rewrites." | write_file description: "Atomically create or fully overwrite a UTF-8 text file. Use for new files or complete rewrites." |
| "Each call replaces the entire list. Always submit every item that should remain; array order is display and execution priority." | update_plan description: "Every call must submit the complete list; array order is both the display and the execution priority." |
| "`bash`: … The default 10-second yield releases the tool call while the same task keeps running … Use `timeout_ms` for an explicit deadline" | bash description: "Wait up to yield_time_ms (default 10000); the same process then continues under its task_id. timeout_ms is an optional runtime deadline" |
| "`glob`: Find files by path pattern and inspect file sizes before reading." | glob description: "Fast glob-pattern file lookup that returns paths and file sizes." |

保留的是 schema 不承载的**行为与政策**：cwd 语义与 Windows 提醒、何时才需要规划、读取体积规则、并行调用、安全约束、沟通风格、技能与 RIND.md 规则。

依据：pi 的工具说明由工具自身贡献且只为选中工具渲染（1.4），opencode 只为存在的工具渲染指引——两边都不重复。

### P1 工具指引随工具走（−139 tokens/请求）

`ask_user_question` 的指引（选项结尾必须是 ` (Recommended)`、不要自造 Other 等）目前放在 system 消息里；它本质是**该工具的参数契约**。移入该工具自己的 schema/描述（pi 的 `toolGuidelines` 归属方式），system 消息随之消失。

### P2 goal 能力按需披露（−225 tokens/请求）

`update_goal`（90 tokens）与 `goal_policy`（135 tokens）目前恒定注入，即使没有活跃 goal。改为：**仅在存在活跃 goal 时**注入策略文本；`update_goal` 工具同理按需 advertise。

依据：opencode 的 Instructions 有 `initial/changed/removed` 三态，能力出现时指引出现、能力消失时指引消失（`session/context.ts` 的注释明确按"跨会话共享度"排序并管理可用性）。rind 的 goal 由用户在 UI 侧设定，模型只需要在 goal 存在时知道如何收尾。

### P3 广告工具集瘦身（仅 glob/grep 为可选 −335 tokens；未采纳）

| 项 | 省 | 依据与能力影响 |
|---|---|---|
| 隐藏 `bash_output` | **新增 0** | main 已隐藏，只需保留 handler 与历史恢复；不能算本轮收益 |
| 隐藏 `glob` + `grep` | 335 | pi 默认不选中等价工具，并在规则里明写 "Use bash for file operations like ls, rg, find"。需同步把系统提示的搜索规则改为 bash 版（pi 的 `buildRules` 原文） |

`glob`/`grep` 属**可选**项：能力上 bash 完全覆盖（且模型在基准里本来就用 `bash` 跑 `ls`/`for f in …`），但会改变工具选择行为，建议先在 18 次复测里验证通过率不降再保留。

### 历史预期（未验收）

下表保留原方案估算，含上述广告集合统计问题；P3 未采纳，不能将表中费用或排名当成修复后结果。

| | 现在 | P0+P1+P2 | +P3（含 glob/grep） |
|---|---|---|---|
| 固定前缀/请求 | ~4,700 | ~3,200 | ~2,750 |
| 缓存读/次 | 23,609 | ~18,000 | ~16,000 |
| 成本/次 | $0.00146 | **$0.00141** | **$0.00140** |
| 排名 | 第 2 | 与 pi 并列 | 与 pi 并列 |

---

## 3. 端到端测试设计（真实"打开 rind 并输入"）

沿用第二轮的 S1–S6，并对本轮的"去重"补充三条**信息不丢失**的断言：

| 场景 | 操作 | 通过标准 |
|---|---|---|
| **S1 启动** | 真实 TTY 直接 `node frontend-cli/bin/rind.js`（不设 `RIND_PYTHON`） | banner 正常；worker 为仓库 `.venv/bin/python` |
| **S2 基本往返** | 输入"写文件 + bash 校验 + 指定回复" | 落盘内容、回复、`usage.jsonl` 均正确 |
| **S3 前缀稳定** | 保持其余工具 / 技能 / 项目规则相同，改变环境；另测新会话 | 静态模板一致，同会话 cache key 稳定；记录真实 hit / miss，不保证跨会话第二次命中率 ≥95% |
| **S4 去重不丢信息（新）** | 核对被删工具契约的 schema 承载位置，同时独立验证信任边界、授权例外、规划和读取政策 | 工具说明与独有政策均保留；关键词命中不能单独证明行为等价 |
| **S5 按需披露（新）** | 无 goal 时发一次请求；`/goal` 设定后再发一次 | 第一次：tools 中无 `update_goal`、system 中无 goal_policy；第二次：两者都出现 |
| **S6 工具集（新，仅在采纳 P3 后）** | 请求一次 | 搜索规则为 pi 原文的 bash 版；`glob`/`grep`/`bash_output` 不在 tools 中；用 `bash rg` 完成一次搜索任务并答对 |
| **S7 能力不退化** | 大输出（`seq 1 40000`）与失败命令 | 模型逐字复述截断提示与完整输出路径；正确报告 exit code |
| **S8 回归** | 全量 pytest + 前端 node 测试 + 18 次基准复测 | 失败集合不增；通过率 18/18；成本 ≤ $0.00141 |

---

## 4. 验收指标

| 指标 | 现状 | 目标 |
|---|---|---|
| `system[0]` 模板 tokens | 2,013 | ≤ 900 |
| 广告工具 tokens | 2,181 | ≤ 1,700（P3 可选后 ≤ 1,250） |
| 固定前缀/请求 | ~4,700 | ≤ 3,200 |
| 缓存读/次 | 23,609 | ≤ 18,000 |
| 成本/次 | $0.00146 | ≤ $0.00141 |
| 命中率 | 历史样本 94.7% | 记录 hit / miss，结合成本和通过率评估，不设独立保证 |
| 通过率（3 遍 × 6 任务） | 18/18 | 18/18（不得下降） |

---

## 5. 风险与边界

- **去重丢信息**：S4 同时验证工具契约与独有政策，不能只检索关键词。初版已发生 trust 规则遗漏，本次修复补齐。
- **测试断言与提示文本耦合**：`test_prompts.py` 断言了若干将被删除的句子；应把这些断言改为"断言其存在于对应工具 schema"，而不是简单删除（否则会丢失回归保护）。
- **按需披露的状态来源**：`enable_goal` 是容器级开关；按需披露需要会话级的"是否有活跃 goal"，复用现有 `session.get_goal()` 并判断 status == active，不以记录存在代替活跃；真实 store 覆盖 paused / blocked / complete / clear，不新增状态。
- **工具集瘦身的可逆性**：`glob`/`grep` 的隐藏若在 18 次复测里未带来成本优势或出现通过率波动，立即回退——它们的 335 tokens 是"可选收益"，不是必需项。
- **命中率口径**：hit/(hit+miss) 不会因前缀变小而必然上升；只减少 hit、miss 不变时反而下降。验收同时比较绝对 miss、cache read、总成本、调用数和任务成功率。
