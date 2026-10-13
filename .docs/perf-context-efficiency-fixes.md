# perf/context-efficiency 修复与验证报告

日期：2026-10-13。审阅起点 `cdf5ff8`，修复代码终点 `5ffe2ac0a6991aa9ea7499808bd49109c805d31d`；对照 main / merge-base `42c20485416a8942585ff6423d7b6b3f6dd67e4d`。原始审阅见 [严格审阅报告](perf-context-efficiency-review.md)。

已修复审阅发现的 R1–R6、G1–G3、Manager 集成断言，以及继续追踪发现的旧会话模板、解释器入口、图片附件和 UI 回放缺口。保留工具能力、推理设置、完整结果引用和分页读取；没有引入预热服务或新的传输层。全量自动回归没有新增失败，但并非全绿：Python 仍有 23 项、CLI 仍有 3 项基线失败。

## 1. 上游源码依据

研究使用用户指定的本地仓库，冻结版本如下。下文链接均固定到这些提交，避免引用随上游变化。

| 上游 | 本地路径 | 提交 |
| --- | --- | --- |
| Codex | `~/code/opensource/codex` | `12cca49c81c8aa6a37a5cc4e39964ee3b70f9458` |
| Pi | `~/code/opensource/pi` | `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` |
| Opencode | `~/code/opensource/opencode` | `b4a57f6849b9a368439b5fc2511fe167db1a6863` |

| 依据 | 实际实现与采用的边界 |
| --- | --- |
| U1：模型输出有界、全文可取、超时可见 | Pi [truncate.ts](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/tools/truncate.ts#L11) 同时限制 2000 行、50 KiB；[bash.ts](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/tools/bash.ts#L255) 保留全文文件。Codex [format_exec_output_str / build_content_with_timeout](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/mod.rs#L116) 在序列化前截断，并明确报告超时。Rind 沿用已有的 25 KiB / 2000 行额度。 |
| U2：业务结果与模型/UI 投影分离 | Pi [AgentToolResult](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/agent/src/types.ts#L424) 将 content、details、structuredContent 分开，错误时仍保留 details。Opencode [Tool.project](https://github.com/anomalyco/opencode/blob/b4a57f6849b9a368439b5fc2511fe167db1a6863/packages/ai/src/tool.ts#L258) 独立生成模型与结构化输出。 |
| U3：状态独立于展示正文 | Codex [ExecCommandEndEvent](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/protocol/src/protocol.rs#L3695) 独立承载输出、exit_code、status。Pi [ToolExecutionComponent.updateResult](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L187) 保存 content/details/isError 后统一渲染。 |
| U4：图片不混入文本预算 | Pi [read.ts](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/tools/read.ts#L135) 分别返回 text / image content；同文件第 175 行起对超长首行给出可操作的 bash 切片指引。 |
| U5：成功落盘后才清除待写状态 | Pi [SettingsManager.enqueueWrite](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/settings-manager.ts#L574) 先执行 write task，成功后 clearModifiedScope；异常仅记错。Rind 将同一成功提交原则用于已有索引去重快照。 |
| U6：会话级缓存亲和 | Codex [ModelClient.prompt_cache_key](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/client.rs#L641) 默认使用 session_id；Pi [Chat](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/ai/src/api/openai-completions.ts#L826) / [Responses](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/ai/src/api/openai-responses.ts#L330) 使用 options.sessionId；Opencode [model-request.ts](https://github.com/anomalyco/opencode/blob/b4a57f6849b9a368439b5fc2511fe167db1a6863/packages/core/src/session/model-request.ts#L278) 使用 SessionAffinity。兼容端点拒绝可选参数时，Rind 沿用现有的参数降级重试方式。 |
| U7：工具输出不能自行扩展授权 | Codex [guardian 的 Evidence Handling](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/prompts/templates/guardian/classifier_instructions.md#L9) 将工具输出视作不可信数据，同时承认用户可明确授权遵循指定内容。采用的是这个信任边界，没有移植 Guardian 子系统。 |
| U8：提示随有效工具集重建，保留自定义追加 | Pi [setActiveToolsByName / _setActiveTools](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/agent-session.ts#L1522) 变更工具后重建提示；[_rebuildSystemPrompt](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/agent-session.ts#L1704) 同时保留 selectedTools、customPrompt、appendSystemPrompt。Opencode U6 中同次请求使用实际 hooked tools 快照。Rind 仅迁移可精确识别的历史内置模板。 |
| U9：模型级窗口覆盖 | Pi [ModelOverrideSchema](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/model-config.ts#L30) 校验正 token 数；[provider-composer.ts](https://github.com/earendil-works/pi/blob/7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6/packages/coding-agent/src/core/provider-composer.ts#L197) 优先模型覆盖值，并在构造模型时检查合法性。Rind 按 connection/model 精确覆盖，避免全局值污染不同模型。 |
| U10：显式可执行文件选择优先 | Codex Python SDK [resolve_codex_bin](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/sdk/python/src/openai_codex/client.py#L178) 优先显式 codex_bin，未指定才用安装默认值。Rind 借鉴的是选择优先级，不是声称 Codex 存在同名的 Python 解释器 resolver。 |

这些是实现依据，不是照搬整套架构。任务游标、goal 状态和救援预算仍遵守 Rind 自身已有契约；恢复合法的 `None` 是对既有 snapshot/restore 契约的补全，不虚构上游存在对应函数。

## 2. 修复闭合与 Git 提交

| 提交 | 闭合问题 | 最终行为与依据 |
| --- | --- | --- |
| `87fb80d` | R1、R2、R3、R4 | shell 的真实 task 形状也执行 UTF-8 字节 / 实际行数双限制，保留全文引用、终态原因和续读操作；保存 `outcome.result`，从 `record.result` 复用，任务通知继续拿业务结果。补齐 lost/failed 分类。依据 U1–U3。 |
| `39bc846` | R5 | repository 返回写入是否成功；仅成功后更新索引去重快照。同一摘要在瞬时写失败后仍能重试。依据 U5。 |
| `9ec31cd` | G1 | Chat 与 Responses 使用相同会话亲和键；正常 turn、手动 compact、客户端替换均绑定当前 session provider。无 session 不发送键；端点明确拒绝参数后去除并记住降级。依据 U6。 |
| `89d0fcd` | R6、G3、Manager 新增失败 | 恢复不可信输出规则及用户明确授权例外；仅 active goal 广告策略和 update_goal，保留 handler 以处理恢复中的既有调用；集成断言改查真实提问 schema。依据 U7、U8。 |
| `5743c1f` | G2 | 救援结束恢复原 hard limit，包括 `None`；新增 `modelContextWindows` 精确覆盖、严格正整数校验，模型切换后预算使用相应窗口。依据 U9 和现有恢复契约。 |
| `1b6bb41` | 旧会话未升级优化模板 | 识别四个已知内置模板，迁移到当前模板，保留环境块和 custom suffix；未知自定义模板保持既有局部迁移规则。依据 U8。 |
| `cfbb6f0` | 各启动入口的解释器选择不一致 | CLI、shared server、management、desktop 共享 source resolver；显式 `python` / `python3` / 路径均原样保留，未指定才选本平台仓库 venv，再回落平台解释器。依据 U10。 |
| `681cfad` | 超大诊断绕过模型限长、图片附件重复保存 | 状态原因 / 诊断本身超长也进入有界投影；原始 result 与顶层 attachments 分离保存，复用时重新附回。真实工具分页和图片 reopen 链路有回归覆盖。依据 U1、U2、U4。 |
| `5ffe2ac` | 原始结果恢复后暴露的 UI 回放与失败分类缺口 | 回放不直接输出 raw result，而是重新生成有界终端预览；实时 / 复用 / 回放共用 domain 分类函数，保留 tool_name、error_type、error_source。read 首行超限的投影错误仍报告失败，完整业务记录保留原样。依据 U1–U4。 |

### 输出、持久化、续读

- 模型侧保留原有 25 KiB / 2000 行上限，实时和回放均使用终端预览。正文、诊断以及 CJK 的 UTF-8 字节都纳入验证。
- `result` 是工具原始业务结果；`model_content` 是模型投影；终端内容从原始结果生成。三个消费者不再互相充当业务事实。
- running、timed_out、cancelled、lost、failed 的状态 / 原因保持可见。已完成任务有未读输出时仍提供 task_id / cursor。
- snapshot 截断后从 start_cursor 重读；实际分页结果从 next_cursor 继续，避免跳过首批被投影截掉的正文。生产 ShellTools + 本地 fake subprocess 测试逐页重建 3000 行全文。
- 图片执行、源文件删除、session reopen、同调用 ID 复用后仍能读取同一快照，附件引用只保存一次。

终端本身仍是有损预览，不能用于证明持久化无损；未知历史会话中此前已经截掉的内容也无法凭空恢复。新的执行与复用链路保存原始结果，已有任务全文仍按原路径 / 分页契约访问。

### 提示、缓存和预算

- 缓存键为 `rind:` 加 session_id 的 SHA-256 前 24 个十六进制字符；同一会话的 cwd、日期、goal、工具集变化不改键。文本前缀本身发生变化仍可能 miss。
- 原审阅 G1 提议静态模板 / schema hash；深入对照三家上游后，最终采用会话 affinity。它保证稳定路由意图，不能保证跨会话共享或实际命中率。
- goal 测试使用真实 store，覆盖 None → active → paused → blocked → complete → active → clear；只有 active 暴露当前能力。
- 四个模板 fixture 来自 `42c2048`、`dc7769a`、`6d4c90e`、`cdf5ff8`。精确识别内置部分后升级，自定义尾部继续保留，未知自定义提示不会被整段覆盖。
- 自定义连接使用 `modelContextWindows[connection_or_provider_id][model_id]`。覆盖值优先于 catalog / 已支持的远程 metadata；不恢复废弃的全局 `contextWindow`，不猜测任意 `/models` 字段。用法见 [settings 文档](../docs/internals/06-models/authentication-and-settings.md)。
- 索引仍仅在列表摘要变化时写入，减少 I/O。只有 updated_at 变化不会触发重写，因此列表最近活动时间会滞后于纯 usage 更新；这是保留的语义取舍，失败写入则不再吞掉下一次重试机会。

`glob`、`grep` 保留。`bash_output` 在 main 就不广告，不能算本分支新增 120 tokens 收益。没有降低 reasoning effort、缩减可用输出总量或删掉已有任务能力；自动测试能验证这些接口与数据流，不能替代真实模型能力评测。

## 3. 验证结果

环境：Linux、Python 3.14.6、Node 24.21.0、npm 11.19.0。Python 使用仓库 `.venv`；Node 测试统一将该 venv 放在 PATH 首部，并设置 `RIND_PYTHON`。所有模型请求为 mock / 本地 fake provider。

| 命令 | 最终结果 |
| --- | --- |
| `.venv/bin/python -m pytest test/ -q --junitxml=/tmp/rind-context-fixes-python.xml` | **1480 passed，23 failed，1 skipped，4 subtests passed**，101.66s |
| `npm --prefix frontend-cli test` | **653 passed，3 failed / 656** |
| `npm --prefix agent-management test` | **74/74 passed** |
| `npm --prefix frontend-web test` | **386/386 passed**，43 文件 |
| `npm --prefix mobile test` | **34/34 passed**，4 文件 |
| `npm --prefix desktop test` | **232 passed，0 failed，2 skipped / 234** |
| `npm --prefix mobile run test:e2e` | **通过** |
| `npm --prefix desktop run typecheck` | **通过** |
| `npm --prefix desktop run build` | **通过**，含 Web 构建 |
| `npm --prefix mobile run build` | **通过** |

Python 最终失败集合与修复前 `cdf5ff8` 完全相同：**新增失败 0，消除基线失败 0**；23 项也全部在 main 上复现。通过数由 1429 增至 1480。JUnit 的 tests=1508 包含 4 个通过 subtests，不能将其再算作 1508 个顶层用例。

CLI 的三个失败均为 main / 修复前也存在的 context-board 颜色断言：

1. `bar segments and legend markers follow the assembly order`
2. `occupancy 33/70/90 percent picks neutral/warn/err theme colors`
3. `every theme paints the board only with its own palette`

Manager 从修复前 73/74 恢复为 74/74。Desktop 两项 Windows firewall 检查在 Linux 跳过。额外的工具输出 / 图片 / 分页定向验证 163 项通过；最终回放 / processor / 协议 / compact 生命周期等定向验证 142 项通过。

首轮执行中，Node 测试显式选择 `python` 时命中了不完整的系统环境；后续在正确 PATH 下完整复跑，并保留显式解释器优先的生产行为。Python 首轮暴露的测试替身接口遗漏和投影分类遗漏已修复；五个仅含旧 pyc 的遗留目录已清理。最终结果使用复跑日志，不将早期失败隐藏为通过。

重现环境设置：

```sh
export RIND_PYTHON="$PWD/.venv/bin/python"
export PATH="$PWD/.venv/bin:$PATH"
.venv/bin/python -m pytest test/ -q --junitxml=/tmp/rind-context-fixes-python.xml
npm --prefix frontend-cli test
npm --prefix agent-management test
npm --prefix frontend-web test
npm --prefix mobile test
npm --prefix desktop test
npm --prefix mobile run test:e2e
npm --prefix desktop run typecheck
npm --prefix desktop run build
npm --prefix mobile run build
```

最终日志和机器可读对照见 [fix-evidence](perf-context-efficiency-fix-evidence/)，归档文本仅统一换行并去除行尾空白，原始 /tmp 日志保留；其中 [test-results.json](perf-context-efficiency-fix-evidence/test-results.json) 包含命令、计数、基线失败集合与日志校验值。原始审阅对照保存在 [review-evidence](perf-context-efficiency-review-evidence/)。历史 reproduce.py 针对修复前提交，不能直接用于当前 API。

## 4. 范围与结论边界

本分支原有 11 个提交并非全部直接降低 token 成本：未使用 import 清理、worker / shared host 生命周期、源码解释器和启动错误可见性具有独立目的。此次修复保留这些合理行为，并核对它们的入口一致性。

三轮优化文档的成本表和排名是历史样本，第三轮预测未被本次验证。减少已缓存的静态内容可能使 `hit / (hit + miss)` 下降；成本验收应同时观察 miss、cache read、总费用、调用数和任务成功率。前缀稳定与真实命中分开验证，不能承诺两个新会话第二次必达 90% / 95%。

本次完成当前 Linux 环境下已有自动测试入口和相关构建，没有执行真实计费模型基准、跨平台矩阵、原生 iOS / Android 编译或 frozen runtime 安装验收。因此能确认已发现的实现缺口闭合且未新增自动回归失败，不能据此认证最终成本降幅或所有真实模型任务的能力绝对不退化。

Git 保留备份分支 `review/context-efficiency-before-fixes` → `cdf5ff8`，修复按九个独立提交保存，报告和证据单独提交。构建产生的 iOS 工程版本改动已还原；原有未跟踪 `logs/` 保留。
