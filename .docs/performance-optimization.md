# Rind 性能优化分析报告：对标 pi / codex / opencode

> **2026-10-13 修复后状态**：本文保留本轮的历史测量与方案；金额、排名、预测和旧测试计数不代表修复后的验收结果。当前实现、固定版本的上游源码依据及全量测试见 [修复报告](perf-context-efficiency-fixes.md)。本次未复跑真实计费模型基准。

> **一句话结论：Rind 的能力没有问题，短板全部集中在"每次请求的固定开销"上——固定前缀 4.4k tokens 占单次请求的 70%，且因为 cwd/日期写在 system prompt 顶部而无法跨会话复用；轮间隔 0.33s（pi 的 5 倍）来自每轮对全量上下文重新分词；每次运行冷启 Python worker 又要多付约 1.7s。**
>
> **四个 P0 改动（预计合计 2~3 天）可把单次运行的非模型开销 2.98s → 1.2s，未命中输入 6.96k → ~2.7k，单次成本约减半，而功能与体验零损失。**
>
> 测量口径：所有 token 数字来自**本地计量代理**解析 API 响应里的 `usage`（非软件自报）；耗时来自 5 遍 × 6 任务的基准与逐调用代理日志；上下文构成来自会话目录里的 `latest_context_breakdown` 与 `RIND_TRACE_LLM` 原始 trace。

---

## 0. 摘要：五个最高收益的改动

| # | 改动 | 关键证据 | 预期收益 | 成本 |
|---|---|---|---|---|
| 1 | 把 `environment_context`（日期 / cwd）从 system prompt 顶部移到末尾（或改为首条 user 消息）；`prompt_cache_key` 不再包含 cwd | 同目录重跑命中 95%，换目录立刻 0%；75.9% 会话首调用全冷 | 未命中输入 −60%，成本约腰斩 | 半天 |
| 2 | 用提供商返回的 `usage` 驱动上下文估算，去掉每轮全量 tiktoken | 轮间隔 0.33s vs pi 0.06s；12 轮实验里 4.1s 花在轮间 | −1~2.5s/次 | 半天 |
| 3 | 热路径去掉 `openai` SDK（改 httpx + 现有 SSE 解析）；`rind run` 复用常驻 worker | `import openai` 单项 612ms；非模型开销 2.98s vs pi 1.25s | −1.3~1.8s/次 | 1 天 |
| 4 | 自定义连接读取 `/models` 的 `context_window`（或 settings 显式配置） | 会话上报 `context_window_tokens: 256000`，模型实际 1,000,000 | 长会话避免提前压缩（每次压缩 = 额外调用 + 全量缓存失效） | 1 小时 |
| 5 | 精简固定前缀 4.4k → ~3.2k（去重文件工具规则、goal_policy 改为按需、压缩工具描述） | 工具 11 个共 7.5KB，其中 bash/task_control/update_plan 文案近 900 tok | −11% 输入 | 1 天 |

---

## 1. 测量方法与口径

本报告的结论全部可复现，工具链如下（均在本机 `/home/azzurro/code/agent/benchtest/`）：

| 工具 | 作用 |
|---|---|
| `llmproxy.py` | 位于 `https://api.deepseek.com` 之前的本地反向代理，每 agent 一个端口；解析**响应体里的 `usage`**（`prompt_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens_details.reasoning_tokens`）；对 `stream:true` 自动注入 `stream_options.include_usage`，保证流式调用也有计量 |
| `bench.py` / `bench_repeat.py` | 6 个任务（3 个 SWE-bench 风格 + 3 个 Terminal-Bench 风格）× 5 个 agent × 5 遍；隐藏测试判分；按代理日志切片归属调用 |
| `analyze_sessions.py` | 遍历 `~/.rind/sessions`，统计轮次、工具分布、上下文构成、缓存、压缩 |
| `RIND_TRACE_LLM=1` | Rind 自带的原始 LLM trace（请求体 + 每个响应块 + 时间戳），用于逐调用耗时分解 |

口径说明：

- **命中率** = `cache_hit / (cache_hit + cache_miss)`，其中 hit 取 `prompt_cache_hit_tokens`（Anthropic 兼容路径取 `cache_read_input_tokens`），miss 取 `prompt_cache_miss_tokens`（或 `input_tokens + cache_creation`）。
- **成本**按目录价目表自算：input `$0.3`/M、output `$1.2`/M、cacheRead `$0.006`/M。**不使用任何软件自报的成本。**
- "非模型开销" = 墙钟 − 调用数 ×（API 中位延迟 + 轮间隔中位），包含进程启动、握手、事件处理、持久化与关闭。

---

## 2. 现状画像（实测）

### 2.1 一次请求的解剖

以 `RIND_TRACE_LLM=1` 抓到的真实请求为准（`~/.rind/sessions/<id>/_llm_trace/`）：

| 组成 | 体量 | 说明 |
|---|---|---|
| `system[0]` 主提示 | 9,118 字符 ≈ 2,280 tok | `<environment_context>` 出现在**第 161 个字符**，即最顶部 |
| `system[1]` 工具指引 | 556 字符 ≈ 139 tok | 仅当存在 `ask_user_question` |
| `system[2]` 目标策略 | 540 字符 ≈ 135 tok | **无条件注入**，即使没有活跃目标 |
| 技能目录 | ~143 tok（中位） | 有技能时才注入 |
| **tools（11 个）** | 7,551 字符 ≈ 1,887 tok | bash 263 / task_control 277 / update_plan 215 / read_file 206 / grep 183 / edit_file 158 / glob 150 / search_web 125 / write_file 118 / update_goal 98 / fetch_web_page 90 |
| **固定前缀合计** | **≈ 4,400 tok** | 首调用实测 4,439 tok |

平均每次请求 6,217 tok（32,329 tok / 5.2 次调用），**其中 70% 是每次都要重发的固定前缀**。Rind 的输入成本本质上由静态内容的重复发送决定。

对应源码：

- 模板与环境注入：[`agent/prompts.py`](../agent/prompts.py)（`_ENVIRONMENT_MARKER` 位于模板第 176 行附近，`build_system_prompt` 在文件末尾）
- 环境内容生成：[`agent/infrastructure/environment.py`](../agent/infrastructure/environment.py)（`get_system_info` 输出 `Current Date` 与 `Current Working Directory`）
- 额外 system 消息的插入位置：[`agent/application/context/manager.py`](../agent/application/context/manager.py)（`_insert_after_first_system`）

### 2.2 缓存行为：决定性实验

在同一台机器上连续运行三次 `rind run`（同一 prompt，仅改变工作目录）：

```text
/tmp/ct_a 第 1 次   in=4439  cached=0     hit=0.00   ← 冷
/tmp/ct_a 第 2 次   in=4439  cached=4224  hit=0.95   ← 命中
/tmp/ct_b 第 1 次   in=4439  cached=0     hit=0.00   ← 换目录 = 全量未命中
```

结论：缓存机制本身工作正常，**但可复用的前缀被工作目录（以及日期）绑死了**。前端缓存 key 也一样：

```python
# agent/infrastructure/llm/openai_chat.py::_build_prompt_cache_key
payload = {"model": ..., "cwd": os.path.normcase(os.path.realpath(...)), "system": ..., "tools": ...}
```

`cwd` 同时出现在 system prompt 文本与 cache key 里，双重绑定。

全局会话统计印证：**75.9% 的会话（41/54）首次调用 `cached_input_tokens == 0`**。

### 2.3 耗时分解

5 遍 × 6 任务基准（30 次/agent）与代理逐调用日志：

| agent | 秒/次（均值±σ） | 调用/次 | API 中位 | **轮间隔中位** | 模型时间/次 | **非模型开销** |
|---|---|---|---|---|---|---|
| pi | 7.09 ± 2.19 | 4.2 | 1.32s | **0.06s** | 5.84s | 1.25s |
| codex | 8.23 ± 2.70 | 4.7 | 1.38s | 0.11s | 7.00s | 1.23s |
| opencode | 9.85 ± 5.32 | 5.6 | 1.28s | 0.17s | 8.14s | 1.69s |
| **rind** | **11.72 ± 4.03** | 5.2 | 1.35s | **0.33s** | 8.68s | **2.98s** |
| claude | 12.47 ± 4.23 | 5.6 | 1.73s | 0.16s | 10.52s | 1.83s |

Rind 的单次 API 延迟与 pi 几乎相同（1.35s vs 1.32s），**全部差距都在轮间隔（5 倍）与非模型开销（2.4 倍）**。

12 轮真实 trace 的逐轮拆分（同一任务）：

```text
调用   API(s)   轮间隔(s)   消息数
 1      1.18     0.33        4
 2      0.78     0.31        7
 3      7.41     0.41       10
 ...
12      1.69     0.35       29
合计  api=25.64s   轮间合计≈4.1s   墙钟=29.5s（另有约 2.0s 进程启动）
```

非模型开销里可以明确定量的部分：

- **进程启动**：node CLI `--version` 0.25s；Python worker 导入 **0.94s**，其中 `import openai` 单项 **612ms**（`openai.types.*` 类型树 586ms）。
- **每次请求前后**：`estimate_messages` 每轮对**全部历史消息**跑 `tiktoken(cl100k_base)`（[`agent/application/context/estimator.py`](../agent/application/context/estimator.py)，`token_cache` 只在 rescue 分支启用）。
- **每轮上下文重建**：`_build_rind_doc_messages` 读 RIND.md、`_build_skill_catalog_messages` 读技能目录（[`agent/application/context/manager.py`](../agent/application/context/manager.py)）。

### 2.4 会话历史分析（371 个会话）

| 指标 | 值 |
|---|---|
| 有 usage 记录的会话 | 54 个，共 234 次 LLM 调用 |
| 总输入 / 缓存命中 / 输出 | 1.4M / 1.1M / 0.04M → **全局命中率 79.5%** |
| **首调用全冷（cached=0）** | **41/54 = 75.9%** |
| 每会话调用数 | min 1，p50 5，p90 7，max 8，均值 4.3 |
| 上下文构成（中位 tok） | system_prompt 2,221 / tool_specs 1,891 / **bash 结果 1,432** / assistant 593 / read_file 583 / reasoning 239 / skill_catalog 143 / goal_policy 127 |
| 工具调用分布 | bash 1233、skill 287、read_file 183、search_web 53、glob 49、grep 45、write_file 41、update_plan 30、fetch_web_page 27、edit_file 15、update_goal 11 |
| 带工具会话墙钟 | p50 8.8s，p90 14.4s，max 19.4s |
| 上报的 `context_window_tokens` | **256,000（全部 54 个会话）** |
| 触发压缩的会话 | 0（尚未触顶，但阈值本身是错的） |

两个直接结论：

1. 冷启动未命中是**系统性的**，不是偶发。
2. bash 工具结果是最大的可变上下文来源（中位 1,432 tok/次），截断策略会连带影响后续每一轮的输入成本。

### 2.5 客观 token 基准（30 次/agent 平均）

| agent | 输入 | 命中 | 未命中 | 输出 | 命中率 | 成本/次 |
|---|---|---|---|---|---|---|
| pi | 10,014 | 7,953 | 2,061 | 745 | 79.4% | $0.00156 |
| codex | 42,343 | 40,947 | **1,396** | 822 | **96.7%** | $0.00165 |
| opencode | 29,091 | 24,316 | 4,775 | 852 | 83.6% | $0.00260 |
| **rind** | 32,329 | 25,365 | **6,964** | 940 | 78.5% | $0.00337 |
| claude | 118,587 | 96,768 | 21,819 | 1,302 | 81.6% | $0.00869 |

该次样本中 codex 未命中为 1,396 tok/次，总输入约 42k tok，部分新会话首调用也命中。静态前缀有利于复用，但该观测不能证明跨会话必命中；其显式缓存亲和键默认来自 session_id。

---

## 3. 对标分析：三家值得借鉴的设计

### 3.1 pi（`~/code/opensource/pi`）

1. **系统提示 = 命名 section 的有序集合，`cwd` 是最后一个 section。**
   `packages/coding-agent/src/core/system-prompt.ts` 的 `buildSystemPromptSections` 依次组装 `preamble → tools → rules → docs → addendum → project_context → skills → cwd`。易变内容天然落在尾部。
2. **`diffSystemPromptSections`**：会话中途提示变化时只发送**差异补丁**，不重写整段提示。
3. **缓存预热器**（`core/cache-warmer.ts`，453 行完整经济学模型）：
   - 在 TTL 的 90%（保留 ≥10s 余量）重放**原始请求**，输出上限 1 token；
   - 决策公式：`continuationProbability × missCost − warmCost ≥ $0.05` 才预热；
   - 分档：streaming 期间 ≤60min，idle ≤30min；
   - `isReplayable()` 守卫会破坏缓存的模型族（如 Anthropic budget-based thinking）。
4. **工具输出截断有明确常量**：`DEFAULT_MAX_LINES = 2000`、`DEFAULT_MAX_BYTES = 50KB`，超限写临时文件并把路径交给模型（`core/tools/truncate.ts`）。
5. **隐藏工具（prepareLoadout）**：只能经其他工具间接到达的工具，既不进工具列表也不进提示。

### 3.2 codex（`~/code/opensource/codex`）

1. **`<environment_context>` 放在用户消息里**（`codex-rs/core/src/context_manager/*` 的测试中可见 `user_input_text_msg("<environment_context>…")`），系统提示（`codex-rs/core/gpt_5_2_prompt.md`，21.6KB）**完全静态**。
2. **pre-turn context diff**：环境变化才追加一条 diff 消息，旧前缀保持有效。
3. 窗口与压缩阈值显式外露为配置：`model_context_window = 1000000`、`model_auto_compact_token_limit = 900000`。

### 3.3 opencode（`~/code/opensource/opencode`）

1. **系统提示只有 756 字节**（`packages/core/src/session/runner/prompt/system.txt`），工具指引按需拼接。
2. **`Instructions` 子系统**：每个提示片段有 key 与 `initial / changed / removed` 三种渲染；目录变更不是改提示，而是发一条消息 `"The directory has been changed to X"`，因此**提示前缀永不因状态变化而重写**。
3. `packages/core/src/session/context.ts` 的注释直接写明了本报告的核心原则：

   > "Ordered from most to least shared across sessions so the baseline stays a reusable prompt-cache prefix: user-level catalog and guidance, then project instructions, then the date and environment, which vary by day and directory."

4. **辅助任务用最小模型**：标题生成走 `model.small(...)` + 最小推理档（`context.ts::selectTitle`）。
5. **压缩阈值** = `window − max(10%, RESERVE_MIN)`，并有 `SHRINK_STEPS = [0.7, 0.5, 0.35]` 渐进收缩。

### 3.4 差距矩阵

| 维度 | rind | pi | codex | opencode |
|---|---|---|---|---|
| 易变信息位置 | **system 顶部（第 161 字符）** | section 尾部 | 用户消息 | 用户消息 / 增量消息 |
| 系统提示体积 | 2,280 tok | ~700 tok | ~5,400 tok | ~200 tok |
| 工具 schema | 1,887 tok / 11 个 | 精简 + 隐藏工具 | 大而全 | 精简 |
| 提示变更策略 | 整块替换 | section diff | context diff | Instructions 增量 |
| 每轮上下文估算 | **全量 tiktoken** | 增量 | Rust 侧增量 | 增量 |
| 冷启动 | **每次 spawn Python（~1.3s）** | 编译二进制 | 常驻 app-server | 常驻后台服务 |
| 缓存预热 | 无 | 有（经济学决策） | 无 | 无 |
| 辅助任务用小模型 | 无 | 支持 | 支持 | 有（title agent） |

---

## 4. 优化建议

每条都给出：问题 → 证据 → **最小改法** → 预期收益 → 风险与边界。原则是**轻量、最小可行、边界清晰**，不新增抽象层。

### P0-1 前缀稳定化：把易变内容移出前缀

**问题**：日期与 cwd 位于 system prompt 最顶部，任何变化都会击穿其后全部内容的缓存；`prompt_cache_key` 又把 cwd 编进 key。

**证据**：2.2 节实验；`agent/prompts.py` 模板中的 `_ENVIRONMENT_MARKER`；`agent/infrastructure/environment.py::get_system_info`；`openai_chat.py::_build_prompt_cache_key`。

**历史方案**（不是最终 cache key 实现）：下面展示环境尾置和删除独立 cwd 字段的思路；修复后 cache key 改为与三家上游一致的会话 affinity，不再哈希整个动态 system。

```python
# agent/prompts.py
_SYSTEM_PROMPT_TEMPLATE = "<静态全文>"           # 不再包含 env
_ENV_SECTION = "\n\n<environment_context>\n{env}\n</environment_context>\n"

def build_system_prompt(workspace_root: str, *, environment: str) -> str:
    static = _SYSTEM_PROMPT_TEMPLATE.replace(_WORKSPACE_ROOT_MARKER, workspace_root, 1)
    return static + _ENV_SECTION.format(env=environment)   # 环境信息追加到末尾
```

```python
# agent/infrastructure/llm/openai_chat.py
payload = {"model": self._model, "system": system_parts, "tools": tools}   # 去掉 "cwd"
```

更彻底（等同 codex，推荐）：环境块作为**第一条 user 消息**发送，system prompt 保持 100% 静态。

另外，[`manager.py`](../agent/application/context/manager.py) 的 `_insert_after_first_system` 把 RIND.md / 技能目录 / 瞬态消息插在 `system[0]` 之后，它们中的任何一个变化同样会作废其后全部内容；应保证它们在会话内字节稳定（现有 `skill_snapshot` 机制已具备），并移动到对话消息之前的最末位置。

**预期收益**：首调用 4.4k 未命中 → 可复用；未命中输入 6,964 → ~2,700 tok/次（−60%），成本约腰斩。

**风险与边界**：环境信息靠后不影响模型读取（pi/opencode 均如此）；需要回归"路径解析 / Windows Git Bash"相关行为测试。

---

### P0-2 用提供商 usage 驱动估算，去掉每轮全量分词

**问题**：每轮构建上下文时对全部历史消息运行 `tiktoken`，是轮间隔的主要来源。

**证据**：`estimator.py::estimate_messages`（`token_cache` 参数存在但仅在 rescue 分支传入）；12 轮实验中轮间隔稳定 0.33s，合计 4.1s。

**最小改法**（不改签名，只改默认行为）：

1. 常开按消息 id 的 `token_cache`，追加消息时增量累加；
2. 直接用上一次响应的 `usage.prompt_tokens` 作为基线，只对新增消息估算（Rind 已经在 `usage.jsonl` 中记录了这些字段）。

**预期收益**：轮间隔 0.33s → ~0.10-0.15s；5 轮省 ~1s，12 轮省 ~2.5s。

**风险与边界**：估算仅用于预算决策（不参与计费），偏差可接受；需要保留 `rescue` 路径的精确口径。

---

### P0-3 冷启动：去掉热路径 SDK 依赖 + 复用常驻 worker

**问题**：每次 `rind run` 冷启 Python worker 并导入 `openai` SDK。

**证据**：`-X importtime` 显示 worker 导入 0.94s，`openai` 612ms；非模型开销 2.98s/次（pi 1.25s、codex 1.23s）。

**最小改法**（两件独立可上线的事）：

1. **热路径去 SDK**：Rind 已有自己的 SSE 解析（`agent/runtime/core/stream_parser.py`）与重试/降级逻辑（`openai_chat.py::_create_with_optional_reasoning_effort`）。把 `stream()` 改为 `httpx.AsyncClient.stream()` 直发 `POST {base}/chat/completions`，`openai` 仅在需要它的连接类型时导入。
2. **worker 复用**：CLI 已具备 shared-host 机制（[`rind-runtime-client/shared-runtime.js`](../rind-runtime-client/shared-runtime.js)、`frontend-cli/lib/agents-commands.js` 中 detach spawn 的 `shared-server.js`）。为 `rind run` 增加 `--shared`（或默认复用并设置 5–10 分钟空闲退出），把每次 1.3s 的启动成本摊薄。

**预期收益**：非模型开销 2.98s → ~1.2s，与 pi/codex 齐平。

**风险与边界**：worker 复用需处理版本不符（源码更新后重启）与残留进程（空闲超时 + 启动握手校验 `version.json`）；httpx 直连需覆盖现有的 `max_tokens` / `reasoning_effort` 降级重试语义。

---

### P0-4 修正 context window（256k → 1M）

**问题**：自定义 `openai-compatible` 连接拿不到模型窗口，回落默认值 256k。

**证据**：54 个会话全部上报 `context_window_tokens: 256000`；`provider_service.py::_remote_context_window` 只映射 `openrouter/mistral/groq`；`/models` 响应里明确带有 `"context_window": 1048576`；`estimator.py` 的 `DEFAULT_CONTEXT_WINDOW_TOKENS = 256000`。

**最小改法**：

```python
def _remote_context_window(item, provider_id):
    field = {"openrouter": "context_length", "mistral": "max_context_length"}.get(provider_id, "context_window")
    ...
```

此处原计划使用全局 `contextWindow`，最终未采纳。修复后支持 `modelContextWindows[connection_or_provider_id][model_id]` 正整数覆盖，优先于已支持的 metadata / catalog；不猜测自定义 `/models` 中未定义的字段，详见修复报告 G2。

**预期收益**：长会话不再提前压缩。**每次压缩 = 1 次额外 LLM 调用 + 前缀重写（全量缓存失效）**，是目前潜在的最贵事件；同时避免 `reduce_hard_limit` 触发的 rescue 裁剪。

**风险与边界**：窗口变大意味着单次请求可能更长，需要同时修正 `max_output_tokens` 的推导，避免超限报错后走恢复路径。

---

### P1-5 缓存预热（对标 pi 的经济学决策，精简版）

**问题**：Rind 完全没有预热。会话空闲超过缓存 TTL 后，下次请求全额未命中。

**收益模型**（DeepSeek 价目：命中读 `$0.006`/M vs 未命中 `$0.3`/M，**50 倍价差**）：

- 预热一次 4.4k 前缀 ≈ `$0.000026`；
- 一次冷未命中 ≈ `$0.0013`。

**最小实现**（独立模块，约 60–80 行，不侵入主循环）：

```python
# agent/infrastructure/llm/cache_warmer.py
@dataclass(frozen=True)
class WarmDecision:
    action: Literal["warm", "stop"]
    warm_cost: float          # 命中读 + 1 token 输出
    miss_cost: float          # 未命中差价
    continuation_probability: float
    expected_savings: float
```

- 触发点：一次真实请求结束后，记住该请求的 payload 与 `prompt_cache_key`；
- 定时：`ttl × 0.9`（TTL 由配置给出，例如 1h）；
- 执行：原 payload 静默重放，`max_tokens=1`、`stream=False`；
- 门槛：`p × miss_cost − warm_cost ≥ 0.001`（比 pi 的 $0.05 低，因为 DeepSeek 单价低两个数量级）；
- 开关：`settings.json` 的 `cacheWarming: "off" | "after_turn" | "idle"`，默认 `off`；`rind run` 建议默认 `after_turn`。

**接口边界**：只依赖 `ChatClient.create()` 与 `ModelCompletion.usage`，不新增端口、不改协议。

**风险与边界**：预热是真实计费调用，必须有开关与成本上限；重放必须与原始请求逐字节一致，否则预热无效（这也正是 P0-1 的前置依赖）。

---

### P1-6 精简固定前缀（4.4k → ~3.2k）

| 改动 | 位置 | 省 |
|---|---|---|
| `FILE_TOOL_RULES` 在 system prompt 与文件工具描述里重复 → 只保留一处 | `agent/prompts.py`、`agent/infrastructure/tools/files/specs.py` | ~175 tok |
| `goal_policy`（540 字符）无条件注入 → 仅在存在活跃目标时注入 | `agent/bootstrap/container.py`、`agent/prompts.py::build_goal_policy_prompt` | ~135 tok |
| bash（587 字符）、task_control（296）、update_plan（358）描述中的叙事性指引收敛为"参数说明 + 一条规则" | 各 `specs.py` | ~250 tok |
| 技能目录改为增量（见 P2-9） | `agent/application/context/manager.py` | ~143 tok |
| **合计** | | **~700 tok/次（约 11%）** |

**原则**（照抄 opencode）：工具描述里只保留**模型无法从 schema 推断**的信息。

**风险与边界**：需用同一批判分任务回归，确认工具选择准确率不下降。

---

### P1-7 减少轮次

**问题**：`agent/prompts.py` 的 "Mandatory Planning Protocol" 要求"**After each significant action, call `update_plan` again**"，会产生只调用 `update_plan` 的额外轮次。基准里 rind 5.2 调用/次 vs pi 4.2。

**最小改法**：改为"仅在**计划本身发生变化**时更新"，删除逐动作强制要求。

**预期收益**：−0.5~1 轮/次 ≈ −6k 输入、−1.5s。

**边界**：Rind 的并行工具调用已经实现（`agent/application/tools/processor.py` 使用 `create_task` + `gather`），无需改动；只需调整提示。

---

### P2-8 输出精简

输出 940 tok/次 vs pi 745（+26%）。在沟通规范里增加两条硬约束：

1. 最终回答不超过 N 行；
2. 不复述文件内容或工具输出，只给结论与路径。

**预期收益**：−150~250 tok/次；金额影响小，但直接改善可读性。

---

### P2-9 增量注入（opencode `Instructions` 的精简版）

**问题**：RIND.md / 技能目录 / 瞬态消息被插入到 `system[0]` 之后，任何变化都会让其后全部内容缓存失效。

**最小实现**（不引入框架）：

```python
def stable_or_delta(previous_hash: str | None, text: str) -> tuple[str, str]:
    """首次出现返回完整块；之后仅在内容变化时返回一小段增量说明。"""
```

- 每个块维护内容 hash；
- 未变 → **原样复用已持久化的那条消息**（保证字节一致）；
- 变化 → **追加一条增量消息**（"RIND.md 已更新，以下内容取代前者：…"），而不是替换旧块。

**风险与边界**：增量累积会轻微增加尾部 token，需要在 N 次增量后做一次合并（阈值可从 8 次起）。

---

### P2-10 观测性（让以上每项都可验证）

Rind 已有 `latest_context_breakdown` 与 usage ledger，只需补齐三个字段即可闭环：

1. 每轮记录 `cache_hit_rate`（已有）与**首调用冷启标记**；
2. 每轮记录 `api_ms / tool_ms / build_ms`（trace 已带时间戳，只需聚合）；
3. `/status` 显示 `context_window_tokens`（当前错报 256k，可直接暴露 P0-4 是否修复）。

---

## 5. 实施顺序与验收指标

| 阶段 | 内容 | 验收指标 | 预估 |
|---|---|---|---|
| 第 1 步 | P0-1 + P0-4 | 验证静态提示前缀及同会话 key 稳定；窗口匹配所选模型 / 显式覆盖；实际 cached tokens 另测，不承诺跨会话必命中 | 半天 |
| 第 2 步 | P0-2 | 轮间隔中位 ≤0.15s；12 轮实验总时长下降 ≥20% | 半天 |
| 第 3 步 | P0-3 | 非模型开销 ≤1.5s/次（用同一套代理计量复测） | 1 天 |
| 第 4 步 | P1-6 + P1-7 | 固定前缀 ≤3.2k tok；调用/次 ≤4.5 | 1 天 |
| 第 5 步 | P1-5（默认关闭，`rind run` 开启） | 空闲 5 分钟后重跑，首调用命中率 >80% | 1 天 |
| 收尾 | P2-8 / P2-9 / P2-10 | 输出 ≤750 tok/次；RIND.md 变更不再击穿缓存 | 1 天 |

复测办法（现成工具链）：

```bash
cd ~/code/agent/benchtest
python3 llmproxy.py                 # 常驻会话
python3 config_proxy.py apply       # 各 agent 指向计量代理（带备份）
python3 bench_repeat.py 5           # 6 任务 × 5 agent × 5 遍
python3 config_proxy.py undo        # 还原
python3 summarize_repeat.py         # 均值 ± 标准差 + 命中率
```

会话侧验证：`python3 /tmp/analyze_sessions.py`（或将其固化进 `benchtest`）。

---

## 6. 实施记录与实测结果（分支 `perf/context-efficiency`）

以下记录第一轮当时落地的四条改动；后续修复以本文开头链接的报告为准：

| 提交 | 内容 |
|---|---|
| `perf(prompt)` | 环境块（日期 / cwd）移到 system prompt 末尾，正文中的绝对项目路径移除；删除 cache key 的独立 cwd 字段及专用 `workspace_root` 传参链；但当时仍哈希含环境的 system，隐式动态 key 缺口后由 `9ec31cd` 改为会话 affinity |
| `perf(session)` | 会话索引只在"列表摘要"变化时重写（`updated_at` 单独变化不触发），写次数 36 → 17 |
| `perf(prompt)` | 删除 write_file / edit_file 描述里与系统提示重复的句子；计划协议不再要求"每个动作后都调用 update_plan" |
| `perf(context)` | 会话预算使用所选模型的真实 context window（此前恒为 256k 默认值），并在 `/model` 切换时刷新 |

实测（rind，6 任务 × 5 遍 = 30 次，token 由计量代理从 API 响应统计）：

| 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| **未命中输入 / 次** | 6,964 | 4,975 | **−28.6%** |
| **成本 / 次** | $0.00337 | $0.00276 | **−18.0%** |
| 命中率 | 78.5% | 83.4% | +4.9pp |
| 总输入 / 次 | 32,329 | 29,964 | −7.3% |
| 调用数 / 次 | 5.17 | 4.97 | −0.2 |
| 墙钟 / 次 | 11.72s | 9.87s | −15.9%（该时段 API 延迟本身低约 10%，见下） |
| **轮间隔中位**（与 API 无关） | 0.333s | 0.264s | **−21%** |
| 测试套件 | 19 项既存失败 | 19 项（无新增） | — |

对照实验：换到全新工作目录后，首调用命中量由 0 提升到 1,920 tokens（系统提示静态部分），同目录重跑仍为 4,224/95%。

### 未采纳项与原因

| 项 | 决定 | 原因 |
|---|---|---|
| P0-3 用 httpx 替换 `openai` SDK | 未做 | SDK 导入 612ms 中大部分是 `openai.types` 的类型树；替换等于重写传输层（流式、重试、错误映射），与"复用既有实现、避免从零开始"冲突，收益 0.6s/次不值得该风险 |
| P0-3 worker 复用 | 未做 | 会改变 one-shot 的生命周期语义（文档明确承诺"不留后台服务"）；应作为独立改动设计 |
| P1-5 缓存预热 | 未做 | 属于新增子系统（定时器 + 重放 + 开关）；且 P0-1 落地后前缀跨会话可复用，预热收益下降 |
| P1-6 条件注入 goal_policy | 未做 | 需要按会话目标状态决定 system 消息，改变行为语义（127 tokens/次），不如保留恒定注入清晰 |
| P2-9 增量注入、P2-10 新观测字段 | 未做 | 前者是框架级改动；后者会引入没有消费者的字段，违背"如无必要勿增实体" |
| 环境块改为用户消息（进一步 +2.3k 命中） | 未做 | 需要改变请求中的消息角色；当前方案（末尾 system 段）已消除首调用 43% 的未命中，剩余部分留作后续 |

---

## 7. 明确不建议做的事

- **不要引入多级缓存或向量检索**：本场景的瓶颈是前缀稳定性，不是检索能力。
- **不要为省 token 砍掉工具能力**：11 个工具中 read/write/edit/glob/grep/bash 是核心；要砍的是**描述文字**，不是工具本身。
- **不要照搬 pi 的完整 cache-warmer**（453 行含成本模型与事件系统）：DeepSeek 场景下"TTL × 0.9、`max_tokens=1` 重放、期望收益 > 阈值"三条即可。
- **不要把动态技能目录塞进 system prompt**：使用 P2-9 的增量模式。
- **不要为追求"前缀稳定"而牺牲信息准确性**：环境信息仍然要发，只是位置靠后。

---

## 8. 附录

### 8.1 关键源码索引

| 主题 | 位置 |
|---|---|
| 系统提示模板 / 环境注入 / 目标策略 | `agent/prompts.py` |
| 环境信息采集 | `agent/infrastructure/environment.py` |
| 上下文装配 / 额外 system 消息插入 / 技能目录 | `agent/application/context/manager.py` |
| 上下文估算（tiktoken） | `agent/application/context/estimator.py` |
| 压缩阈值与救援 | `agent/application/context/compaction.py`、`agent/domain/compaction.py` |
| 提示缓存 key | `agent/infrastructure/llm/openai_chat.py` |
| 模型窗口解析 | `agent/infrastructure/llm/provider_service.py` |
| 主循环 / 轮次 | `agent/runtime/core/turn_runner.py` |
| 工具结果截断 | `agent/application/tools/result_normalizer.py`（25KB / 2000 行预览，终端 8KB） |
| 工具并行执行 | `agent/application/tools/processor.py` |
| 一次性运行（one-shot） | `frontend-cli/lib/one-shot.js`、`frontend-cli/lib/one-shot-progress.js` |
| 共享运行时 | `rind-runtime-client/shared-runtime.js`、`frontend-cli/lib/agents-commands.js` |

### 8.2 对标文件索引

| 主题 | 位置 |
|---|---|
| pi 系统提示分节 + `cwd` 置尾 | `~/code/opensource/pi/packages/coding-agent/src/core/system-prompt.ts` |
| pi 缓存预热器 | `~/code/opensource/pi/packages/coding-agent/src/core/cache-warmer.ts` |
| pi 工具输出截断 | `~/code/opensource/pi/packages/coding-agent/src/core/tools/truncate.ts` |
| codex 环境上下文（用户消息） | `~/code/opensource/codex/codex-rs/core/src/context_manager/` |
| codex 基础提示（静态） | `~/code/opensource/codex/codex-rs/core/gpt_5_2_prompt.md` |
| opencode 提示与上下文排序 | `~/code/opensource/opencode/packages/core/src/session/system-prompt.ts`、`.../session/context.ts` |
| opencode Instructions 增量模型 | `~/code/opensource/opencode/packages/core/src/*/instructions.ts` |
| opencode 压缩阈值 | `~/code/opensource/opencode/packages/core/src/session/compaction.ts` |

### 8.3 原始数据

| 数据 | 位置 |
|---|---|
| 基准结果（150 次运行，含每次 API 调用 usage） | `~/code/agent/benchtest/bench_results_repeat.json` |
| 计量代理日志（逐调用时间戳与 usage） | `/tmp/proxy/<agent>.jsonl` |
| Rind 原始 LLM trace | `~/.rind/sessions/<id>/_llm_trace/*.jsonl`（`RIND_TRACE_LLM=1` 开启） |
| Rind 用量账本 | `~/.rind/usage.jsonl` |

---

*本文由一次完整的性能审计产生：6 个任务 × 5 个 agent × 5 遍的客观计量基准、371 个会话的统计分析、以及 pi / codex / opencode 三个上游仓库的源码对照。所有数字均可按第 5 节的方法复现。*
