# Rind Token 成本优化方案（第二轮）

> **2026-10-13 修复后状态**：本文保留本轮的历史测量与方案；金额、排名、预测和旧测试计数不代表修复后的验收结果。当前实现、固定版本的上游源码依据及全量测试见 [修复报告](perf-context-efficiency-fixes.md)。本次未复跑真实计费模型基准。

> 上一轮（缓存前缀稳定性与启动路径）：[performance-optimization.md](./performance-optimization.md)

> **本轮目标：只打 token 成本（缓存命中 + 输入 + 输出），且以 pi / codex / opencode 的既有实现为唯一依据，不做任何凭空设计；不以牺牲 agent 能力为代价。**
>
> **核心结论：rind 的成本结构是 未命中 40% / 缓存读 7% / 输出 53%。上一轮样本中首调用命中 4,224/4,460 = 95%（codex 为 8,064/8,208），但不能据此认定所有会话 / provider 的首调用问题已解决。剩余差距集中在每轮新增的工具结果：rind 每轮新增工具结果 598–908 字符，而三家样本各异，见 1.1 表，不能统一概括为 0–39。根因是 rind 把工具的内部记账 JSON 原样投影给模型；三家上游都显式实现了"模型投影"与"结构化记录"的分离。**

---

## 0. 本轮明确不做的事（均有上游依据）

| 不做 | 依据 |
|---|---|
| 不压缩推理、不降低 reasoning effort | pi 在 `packages/ai/src/api/openai-completions.ts::convertMessages` 里显式把 thinking block 回放为 `reasoning_content`，并在 `requiresReasoningContentOnAssistantMessages` 且无推理时补 `""`；三家主循环都不降档 |
| 不收紧工具输出上限 | rind 已是 25KB/2000 行预览 + 8KB 终端预览；pi 的 bash 是 50KB/2000 行（`tools/truncate.ts`）→ rind 已经更紧 |
| 不删除/收缩历史工具结果 | codex 的 `context_manager/normalize.rs` 只做 `ensure_call_outputs_present`、`remove_orphan_outputs`、`strip_images_when_unsupported`；rind 已有等价实现（缺失结果占位、按模型能力剥图） |
| 不追加"少给上下文"式裁剪 | 与上一轮结论一致：能力优先 |

---

## 1. 本轮新增的测量（同一套题、代理客观记录）

### 1.1 请求构成（每轮新增字符数）

| agent | system | tools | user | Δ工具结果/轮 | Δ推理/轮 | Δ工具参数/轮 |
|---|---|---|---|---|---|---|
| rind | 10,211 | 7,386 | 623 | **598–908** | 211 | 342 |
| pi | 2,755 | 3,298 | 651 | −12–261 | 181 | 366 |
| opencode | 8,886 | 13,628 | 629 | 39–200 | 161 | 301 |
| codex | —（走 Responses API） | 9,467 | 1,079 | 0 | — | — |

### 1.2 未命中归因

| agent | 首调用未命中 | 每轮增量未命中 | 首调用命中率 |
|---|---|---|---|
| rind | 236 | 537 | 4,224/4,460 = **95%** |
| codex | 144 | 243 | 8,064/8,208 = 98% |
| pi | 186 | 280 | 1,536/1,722 = 89% |
| opencode | 230 | 214 | 5,376/5,510 = 98% |
| claude | 20,324 | 2,560 | 0% |

结论：该样本的首调用命中已有改善；本轮聚焦每轮新增内容中的工具结果，实际缓存路由和跨会话复用仍需单独验证。

### 1.3 工具结果冗余（全库统计）

- 60 个近期会话、280 次工具调用：模型侧 `model_content` 合计 278,469 字符，其中**内部记账字段 151,528 字符 = 54.4%**（`command` 11.7%、`next_cursor`/`start_cursor` 8.5%、`ts` 4.2%、`origin_tool_call_id`/`origin_turn_id`/`request_id`/`owner_session_id` 10.6%、`cwd`/`shell_*`/浮点时间戳等其余）。
- 142 次工具调用的**真实分词器**对比：87,406 tokens → 28,459 tokens（**−67%**）。
- 109 个基准会话：平均每次运行省 **1,019 tokens** ≈ **$0.00031/次（约 −15% 成本）**。

### 1.4 输出构成（每轮）

| agent | 输出 tokens/轮 | 推理占比 | 工具参数占比 | 正文占比 |
|---|---|---|---|---|
| rind | 159 | 55% | 36% | 9% |
| opencode | 137 | 64% | 35% | 1% |
| pi | 263 | 72% | 24% | 5% |

结论：rind 的单轮输出与对手**同级**（137–166 vs pi 的离群 263），且三家上游都没有"压缩输出"的机制；正文占比三者都 <10%。→ **输出侧没有可依据的压缩空间**，只能靠工具结果瘦身间接减少模型推理量。

---

## 2. 改动清单

### P0（唯一大项）工具结果改为"模型投影"

**上游依据**

| 项目 | 位置 | 做法 |
|---|---|---|
| pi | `packages/coding-agent/src/core/tools/bash.ts` | 返回 `content: [{type:"text", text: outputText}]` 给模型；`structuredContent` 给程序化调用者，源码注释：*"output is not limited like the model-facing output: callers decide how much of it reaches the model"* |
| codex | `codex-rs/core/src/tools/mod.rs::format_exec_output_str` | 模型侧只给聚合输出文本（+超时行），注释：*"Truncate for model consumption before serialization"* |
| opencode | `packages/ai/src/tool.ts` | 显式两个投影：`toModelOutput()` → `Tool.Content[]`；`toStructuredOutput()` → 程序化消费 |

**rind 现状**：`agent/application/tools/result_normalizer.py` 产出的 `model_content` 是内部 payload 的 JSON 序列化，例如 bash：
`{"ok":true,"tool":"bash","data":{"command":"…","cwd":"…","elapsed_ms":51,"exit_code":0,"finished_at":1759…,"handoff":false,"next_cursor":"WyJ0YXNr…","notify":"on_exit","origin_tool_call_id":"call_00_…","origin_turn_id":"83d3…","owner_session_id":"2026…","reason":"","request_id":"97fa…","return_reason":"finished","shell_backend":"bash","shell_executable":"/usr/bin/bash","start_cursor":"WyJ0…","…"：“…stdout…"}}`

**最小实现（不改接口、不加抽象）**：在 `result_normalizer` 里把"模型投影"与"结构化记录"分开——`tool_calls.jsonl` 继续保存完整记录（UI、分页、`task_control`、崩溃恢复都用它），只把喂给模型的那一份改为文本投影：

- bash：stdout、stderr、非零退出码/超时、截断提示与 `output_path`（存在时）
- read_file：行内容 + 分页提示（`next_offset`）
- write_file/edit_file：一行变更摘要 + 文件列表（沿用现有 `meta.files`）
- 失败：保留 `error_type` / 错误正文（能力相关，必须保留）

**预期**（按上述实测换算）：每次运行 −1,019 tokens 未命中 ≈ **−$0.00031**，成本 $0.00202 → **≈$0.0016（−20%）**，排名由第 4 升至第 3（超过 codex $0.00168），逼近 opencode $0.00146。

**能力不退化**：模型可见的**信息集合**不变（输出正文、退出码、截断与分页提示、变更摘要、错误），仅去掉游标/ID/时间戳/内部路径/重复命令。

### P1（P0 的组成部分）bash 结果不再重复命令

`command` 占模型侧工具结果字符的 11.7%，而 assistant 的 `tool_calls.arguments` 已经带了同一条命令；pi 的模型侧输出只含命令输出（`formatOutput` 只拼输出与状态行）。→ 投影时不再回显命令。

### P2 保持现状（明确记录，避免后续反复）

- 环境块位置：已按 codex 思路放到 system prompt 末尾，首调用命中 95%；codex 把它放在 user 消息（`user_input_text_msg`）只多约 90 tokens/会话，收益不足，暂不动。
- 工具截断限额、缺失工具结果补齐、无图模型剥图：与 codex `normalize.rs` 等价，保持。
- 辅助调用：opencode 为标题单开一个小模型调用（`context.ts::selectTitle` + `MINIMAL_REASONING_VARIANTS`）；rind 的标题由 `automatic_title(content)` 本地生成，**不消耗任何 token**，是本轮要保住的优势。

---

## 3. 端到端测试设计（真实"打开 rind 并输入"）

所有场景都通过真实 TTY 启动 `node frontend-cli/bin/rind.js`、真实按键输入、真实模型往返；除 S1 外均可用 `RIND_HOME` 指向隔离目录，避免污染用户会话。

| 场景 | 操作 | 通过标准 |
|---|---|---|
| **S1 启动** | 真实终端直接 `node frontend-cli/bin/rind.js`（不设 `RIND_PYTHON`、不 activate 任何环境） | banner 正常渲染；worker 进程为 `<repo>/.venv/bin/python`；任一失败路径（错误解释器）必须打印错误而非静默退出 |
| **S2 基本往返** | 输入"写 final.txt 内容 FINAL-E2E，然后 bash `wc -c` 校验，最后只回 OK-E2E" | 文件存在且内容精确；回复为 `OK-E2E`；`usage.jsonl` 新增一条记录 |
| **S3 前缀稳定** | 保持模型、工具、技能和项目规则相同，比较环境变化前后的请求 | 静态模板逐字节一致，同会话 key 稳定；分别记录同会话 / 新会话实际 cached 与 miss，不承诺第二次命中率 ≥90% |
| **S4 工具结果投影（新）** | 固定脚本回放同一批真实工具调用（bash 成功/失败、read_file 分页、write_file、大输出截断） | 模型侧 `model_content` 去除不参与当前操作的记账字段；仍有未读输出或任务运行时保留 task_id / cursor 等续读信息；保留 stdout、状态原因、退出码、截断提示与全文引用。tokens 降幅另以真实样本复测 |
| **S5 能力不退化** | 大输出命令（>25KB）与失败命令各一次 | 模型侧仍能看到截断提示与 `output_path`；`task_control` 用 cursor 能取回完整输出；失败信息完整可见 |
| **S6 回归** | 全量 pytest + 前端 node 测试 | 失败集合与基线一致（pytest 19 项既存、node 3 项既存），无新增 |

复测口径：`llmproxy.py`（客观计量）+ `bench_repeat.py 5`（6 任务 × 5 agent × 5 遍）+ 本文件 1.3/1.4 的统计脚本。

---

## 4. 验收指标

| 指标 | 现状 | 目标 |
|---|---|---|
| 工具结果模型侧 tokens | 87,406（142 调用样本） | ≤ 35,000（−60%） |
| 基准未命中/次 | 2,667 | ≤ 1,700 |
| 基准成本/次 | $0.00202 | ≤ $0.00170 |
| 基准命中率 | 90.7% | ≥ 92% |
| 通过率 | 30/30 | 30/30（不得下降） |
| 端到端 | — | S1–S6 全绿 |

---

## 5. 风险与边界

- **投影丢信息**：原始业务结果独立保存，不能用 UI 预览代替。固定样本须覆盖实际 task 形状、终态、双流、CJK、分页和复用；当前操作必需的字段仍须提供给模型。
- **游标/分页是操作契约**：不能仅因内部记录保留游标就断言模型不受影响；模型仍需收到当前续读所需的 task_id / cursor。用生产 ShellTools 逐页还原全文验证（S5）。
- **错误可见性**：`error_type`/错误正文属于能力相关字段，必须保留；只删记账字段。
- **缓存行为**：消息变短不保证命中率上升；hit 和 miss 都可能变化。以实际 miss、cache read、总成本、调用数及任务成功率判断，不因命中率单项下降推断前缀错误或自动回退。

---

## 6. 实施记录与实测结果

以下是第二轮当时的两个提交及其已确认的限制；修复后的数据流见本次修复报告：

| 提交 | 内容 |
|---|---|
| `perf(tools)` | `ToolResultNormalizer` 为 shell/task 结果产出文本投影（stdout/stderr + 非零退出码 + 仍在运行的 task 与游标 + 截断提示与 output_path + 输出日志告警），`model_content` 不再是内部 JSON |
| `fix(tools)` | 当时将 `result` 从 model_content 改为终端投影，恢复了 JSON 形状，但终端 8 KiB 预览会裁剪正文和游标，不能称为无损。后由 `87fb80d` 改为保存原始 outcome.result，`5ffe2ac` 补齐有界回放与状态分类 |

实测（真实数据与真实运行）：

| 口径 | 结果 |
|---|---|
| 109 个基准会话、258 次工具调用的模型侧 tokens | 165,338 → **31,520（−81%）** |
| 同一任务前后对照（tb-script × 5 遍，同时间窗） | 未命中 3,044 → **1,373（−55%）**；**调用数 5.60 → 5.60（不变）** |
| 全量基准（6 任务 × 5 遍） | 未命中/次 2,667 → **1,554（−41.7%）**；命中率 90.7% → **94.5%**；成本/次 $0.00202 → **$0.00169（−16.2%）**；通过率 30/30 |
| 每轮新增工具结果 | 中位 598–908 字符 → **260 字符**（与 pi 261 / opencode 39 / codex 0 同级） |
| 每轮增量未命中 | 中位 **246**（pi 229 / opencode 216 / codex 235）→ 输入侧已追平 |

端到端（真实 TTY 打开 rind、真实按键输入、真实模型往返）：

| 场景 | 结果 |
|---|---|
| 启动（不设 `RIND_PYTHON`） | banner 正常；worker 为仓库 `.venv/bin/python` |
| 写文件 + bash 校验 + 指定回复 | 落盘内容精确、回复正确、`usage.jsonl` 有记录 |
| 大输出（`seq 1 40000`） | 模型逐字复述截断提示与完整输出路径；UI 仍显示有界预览 |
| 失败命令 | 模型正确报告 exit code 与非零退出说明 |
| 记录完整性 | 当时仅检查 JSON 可解析，遗漏了正文 / 游标被终端投影裁剪及复用状态失真；这些反例在本次修复中补测并解决 |
| 回归 | pytest 19→18 项既存失败（1 项转为通过）、无新增；前端 node 测试 7 项 = 基线 |
