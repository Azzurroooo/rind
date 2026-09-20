# 用户流程验收（仅按用户要求执行）

这里保存从用户入口操作的验收流程，不是默认测试套件。只有用户明确要求时才执行；本目录不会接入 pytest、npm test、CI 或提交钩子。可以使用命令辅助操作和核验，但不能自动启动整套验收。

## 用例目录

| ID | 场景 | 模型消耗 |
| --- | --- | --- |
| [S01–S08](sessions.md) | run、send、会话生命周期、空会话 compact | 成功对话需要；拒绝路径不应调用模型 |
| [C09](context-and-goal.md) | RIND.md 注入和行为验证 | 少量 |
| [C10](context-and-goal.md) | 自动压缩、任务连续性、恢复 | 较高 |
| [G11](context-and-goal.md) | goal 执行、续轮、暂停、恢复、清除 | 多轮，有持续消耗风险 |
| [B12–B17](boundaries.md) | 恢复、异常、隔离、设置、fork、交互 | 依用例 |
| [T18–T23](team.md) | Team 创建、成员、委派、权限、并发和取消 | 管理操作部分无消耗；委派按父子调用合计 |
| [U24–U29](user-features.md) | Skill、初始化文档、认证、后台任务、多模态、多入口 | 依用例 |

## 执行约定

1. 开始时记录用户要求的用例、版本/工作区改动、操作系统、provider/model、时间和 token 上限。已有授权覆盖这些内容时直接执行，不重复确认。真实模型用例使用用户指定或已配置的模型；缺少凭据时标记阻塞，不擅自切换服务。
2. 默认执行上限：每例 10 分钟、20 次模型调用；C10 另设累计 100 万输入 token、2 万输出 token 上限。用户指定的上限优先。按已完成调用的 usage 检查，不能保证中途精确截断或限制单次账单；达到上限就中断并报告。不得为得到 PASS 无限重试。
3. 使用临时工作区和独立 `RIND_HOME`，不在真实项目中制造故障，不改正常用户会话。两个终端必须使用同一套测试目录、模型配置和环境。
4. 从 `rind`、`rind run`、`rind send` 和斜杠命令进入；需要 GUI/TTY 观察时使用真实终端。仅驱动底层协议的结果不能替代 UI 验收。
5. 用户反馈与持久化/请求证据同时满足才 PASS。模型自称完成、`send` 返回成功、进程退出码为 0，都不能单独证明任务通过。
6. 成功、失败、超时、中断均执行下方清理流程。证据先核验并提取脱敏摘要，最终在回复中报告；默认不保留报告文件、截图、trace、测试会话或其他产物。只有用户明确要求保留时，才保留指定文件并说明位置。

## 隔离环境（PowerShell 示例）

以下命令只在验收被要求后执行。从仓库根目录、专用测试终端开始：

```powershell
$RindRepo = (Get-Location).Path
$AcceptanceRoot = Join-Path $env:TEMP ("rind-acceptance-" + [guid]::NewGuid().ToString("N"))
$AcceptanceWorkspace = Join-Path $AcceptanceRoot "workspace"
$env:RIND_HOME = Join-Path $AcceptanceRoot "home"
New-Item -ItemType Directory -Path $AcceptanceWorkspace, $env:RIND_HOME | Out-Null
$env:RIND_TRACE_LLM = "1"
function rind { & node (Join-Path $RindRepo "frontend-cli/bin/rind.js") @args }
Set-Location $AcceptanceWorkspace
```

将用户已授权使用的模型配置放入测试 `RIND_HOME/settings.json`，或使用对应 provider 的环境凭据；不要输出密钥。第二终端复用第一终端记录的 `$RindRepo`、`$AcceptanceRoot` 和工作区路径，设置相同的 `RIND_HOME`、trace、配置和 `rind` 函数，不要重新生成测试根目录。Unix 使用等效的临时目录、环境变量和 Node 入口。

记录下列证据位置：

- `$env:RIND_HOME/sessions/<id>/meta.json`：会话、轮次、goal、usage。
- 同目录的 `messages.jsonl`、`tool_calls.jsonl`、`compactions.jsonl`：历史、工具和压缩记录。
- 同目录 `_llm_trace/*.jsonl`：支持 trace 的 provider 的实际请求和响应；不支持时记录替代请求证据，拿不到证据则不宣称完成注入核验。
- CLI 输出、退出码、文件内容及必要的终端截图。

负向用例前后比较模型请求数量和文件状态；未触发模型的空会话本来就不应有 trace 目录。token 使用逐次请求的最终 usage 求和，不重复累加流式 usage；缺失时写“未知”，不能写 0。`meta.json` 的最新 usage 不是全流程总量。

## 结果模板

每次分别记录首次失败与修复后的复测，不覆盖失败结论；以下模板用于最终回复，临时报告也必须随测试目录一起删除：

```markdown
日期 / 版本与未提交改动 / OS / 入口：
用户要求的范围 / provider / model / 预算：
隔离目录：

| 用例 | 真实模型 / 无模型 / 模拟 | 结果 | session ID | 耗时 / 调用数 / 输入输出 token | 证据与差异 |
| --- | --- | --- | --- | --- | --- |
| S01 | | NOT RUN | | | |

失败复现步骤：
未覆盖或阻塞原因：
清理检查：临时目录 / 父子进程 / 端口与 IPC / 临时配置凭据 / 外部产物
未清理项与原因（无则写“无”）：
```

## 清理与零残留验收

清理是每次人工验收的完成条件，不能把“测试失败”或“需要排查”当作默认保留垃圾的理由。

1. **开始前登记范围。** 记录本次唯一临时根目录、启动的 PID/子进程、监听端口/IPC、临时凭据及外部测试资源；记录仓库和正常用户会话的基线。Team 的所有 agent 工作区、shared、父子 session，截图、下载、run 日志、缓存和编译输出都应位于本次临时根目录。测试 shell 使用独立终端，避免覆盖用户环境和命令别名。
2. **先取证再停机。** 提取错误、关键输出、必要字段、哈希和 token 统计到脱敏结果摘要。暂停 goal，停止后台任务和委派，退出 CLI/桌面/网关/worker，等待本次子进程退出；超时只终止已登记并核实归属的进程树，不能按 `python`/`node` 名称批量杀进程。
3. **再删产物。** 从测试目录切换出去，核验待删除的解析后绝对路径就是本次登记的临时根目录，且不是仓库、用户 home 或临时目录本身。用当前 shell 的原生文件操作删除；PowerShell 使用 `Remove-Item -LiteralPath <已核验路径> -Recurse -Force`，不拼接跨 shell 删除命令，不遍历到目录外的链接目标。清除独立残留的临时 socket、文件及测试凭据，恢复本次改动的设置和环境。
4. **外部资源也要收尾。** 仅在授权的测试频道/账号下做外部集成；登记并删除本次上传文件、测试消息等可清理资源，恢复本次配置。如果目标不能可靠撤销且用户没有明确接受残留，不先创建该资源，记为 BLOCKED。已经消耗的模型 token/费用及服务商审计记录无法撤销，不得声称已清除。
5. **核验而非只发删除命令。** 确认临时根目录不存在，本次进程均结束，端口不再由本次进程监听、IPC 不可连接；正常用户会话和仓库无本次新增残留。删除失败先释放文件占用再重试；仍无法清理时列出确切路径/资源及原因，将收尾记为未完成，不能报告“全部完成”。

清理仅针对本次产物，不按名称通配删除旧目录或其他人的数据。若用户要求保留某份脱敏报告，将它作为唯一明确例外列出，其余仍须清理。使用临时脚本辅助验收时把清理放在 `finally`；遇到强制退出，下一次接续该验收先按已登记范围清理遗留，再继续测试。
