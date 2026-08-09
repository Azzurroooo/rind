# Rind AI Team 最终设计与收口方案

> 本文是 Team 功能的唯一后续设计依据。它取代《AI_Organization_OS_Design_Implementation_Plan.md》和《AI_Team_OS_Advanced_Implementation_Plan.md》中所有与 Team、Organization、Task、Message、Event、Agent Runtime State 有关的设计。
>
> 目标是让 Rind 具备具名、持久、可独立进入的专长 Agent，同时把协作收敛为一个同步工具调用。Team 不是一个常驻组织控制系统，也不是 Agent 之间的聊天系统。

## 1. 最终结论

一个 Team 是一个项目目录中的多个 Agent Capsule。每个 Capsule 都有固定目录、独立提示词和 Skill、独立 Session，以及可由用户直接进入的工作目录。

主 Agent 负责统筹。它通过 `delegate` 工具调用某个二级 Agent 完成一件事，等待结果后继续自己的回合。二级 Agent 不向主 Agent 发消息，不订阅消息，不维护“当前进度”数据库，也不需要通过 `organization.yaml` 注册。

跨 Agent 的真实事实来自文件，而不是会话记忆：

- Agent 自己的 `memory/`、`work/`、`outputs/` 是其私有工作；
- 需要被团队复用或核验的结论写入项目 `shared/`；
- 委派结果只是对当前工作、阻塞和已发布文件的简洁说明；
- 某次独立会话中没有落到文件的内容，不是团队可依赖的共享知识。

因此，主 Agent 想知道某个二级 Agent 的最新进度时，不读取该 Agent 的历史会话，也不维护同步状态。它调用一次 `delegate(..., mode: "inspect")`，由目标 Agent 自己检查当前目录后回答。

## 2. 借鉴边界

本方案参考了本地源码中的以下实现：

- Codex：`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`
- OpenCode：`packages/opencode/src/tool/task.ts` 与 `packages/opencode/src/tool/task.txt`

两者共同验证了三个应保留的基本模式：

1. 子 Agent 由父 Agent 的工具调用启动；
2. 子 Agent 有自己的 Session，并与父 Session 建立关联；
3. 前台调用等待结果，结果作为普通 tool result 回到父会话。

但 Rind 不复制它们的通用子 Agent 调度系统。下列能力不进入第一版 Team：上下文 fork、可恢复 task id、后台任务、通知、轮询、队列、Agent 层级嵌套、Agent 间消息和任务图。这些能力解决的是通用临时子 Agent 的调度问题，会把 Rind 的具名工作目录模型重新变成一套重型控制面。

Rind 的差异不在于“多 Agent 可以聊天”，而在于每个 Agent 都是一个长期存在、可直接进入、带有专长提示词和 Skill 的 Capsule；主 Agent 的委派仍保持为最简单的同步工具调用。

## 3. 不变的设计原则

### 3.1 文件结构决定 Team 身份

Team 成员不由名册、关系图或运行时注册决定。一个目录只要满足标准结构和 manifest 校验，就是当前项目的 Agent。

复制一个合法的 Agent Capsule 到 `agents/<agent-id>/` 后，不需要修改其他文件。下次主 Agent 初始化时会在目录扫描中发现它；即使当前主 Agent 的清单尚未刷新，用户或模型显式给出该 `agent_id` 时，`delegate` 也会按文件系统重新校验目标。

### 3.2 Session 是 Agent 运行支持，不是项目状态

所有 Session 仍由用户级 `~/.rind/sessions/` 的既有 JSON/JSONL 存储管理。项目目录不保存会话、消息、投递、事件、任务或 Agent 状态数据库。

Session 的 Team 归属只使用已有的最小元数据：

```text
project_id
owner_agent_id
workspace_root
session_type
parent_session_id   # 仅 delegated_task 需要
```

这些字段描述一次会话在哪个 Capsule 中运行，不构成 Team 的运行时状态机。

### 3.3 主 Agent 和二级 Agent 使用同一 Runtime

主 Agent 不是特殊 Runtime。它只是 `project.yaml` 指定的入口 Agent，因而额外获得 `delegate` 和 Agent 创建能力。二级 Agent 的差异完全来自自己的 manifest、提示词和 Skill；它们不能再嵌套委派。

### 3.4 无隐式同步、无兼容启动

不从项目根目录进入默认 Agent，不从 `agents/<id>/` 的子目录向上或向下猜测 Agent，不根据旧 `organization.yaml` 推断成员，也不把任何目录自动切换为 Agent 工作目录。

所有目录和启动判断都应失败得直接、可解释，不能以普通 Agent 或另一名 Agent 静默降级来掩盖 Team 结构错误。

## 4. 唯一标准目录结构

```text
<project-root>/
├── .aiteam/
│   └── project.yaml
├── agents/
│   ├── main-agent/
│   │   ├── .aiteam/
│   │   │   ├── agent.yaml
│   │   │   └── prompts/
│   │   │       └── system.md
│   │   ├── memory/
│   │   ├── work/
│   │   └── outputs/
│   └── <agent-id>/
│       ├── .aiteam/
│       │   ├── agent.yaml
│       │   └── prompts/
│       │       └── system.md
│       ├── memory/
│       ├── work/
│       └── outputs/
└── shared/
```

`skills/`、`workflows/`、额外 prompt 文件及 Blueprint 来源记录仅在实际使用时存在，不创建空目录。

`shared/` 只是一块项目级产物区域，不预设 `datasets/`、`artifacts/`、`reports/`、`decisions/` 等空分类。具体项目需要分类时，由项目内容自己建立。

### 4.1 项目 manifest

`<project-root>/.aiteam/project.yaml` 只定义项目身份和固定根目录：

```yaml
api_version: aiteam/v1
kind: Project
metadata:
  id: quant-project
  name: Quant Project
spec:
  main_agent: main-agent
  agents_root: ../agents
  shared_root: ../shared
```

它不包含 Agent 名册、组织角色、状态、关系、任务、消息、事件或存储后端。

### 4.2 Agent manifest

`<project-root>/agents/<agent-id>/.aiteam/agent.yaml` 定义该 Agent 自己的身份和能力。`metadata.id` 必须等于目录名 `<agent-id>`。提示词、Skill、工作流和文件权限都属于该 manifest；这就是 Agent 目录下 `.aiteam` 对该 Agent 的作用。

Team Runtime 只额外赋予每个 Team Agent 两个项目路径边界：自己的 Agent 根目录，以及项目 `shared/`。它不能以普通运行方式读取或写入其他 Agent 的私有目录。

### 4.3 结构合法性

一个 Team 项目必须具有 `project.yaml`，且 `main_agent` 指向一个合法的直接子目录 Agent。一个 Team Agent 唯一合法的位置是：

```text
<project-root>/agents/<agent-id>/.aiteam/agent.yaml
```

以下均不是 Agent 启动入口：项目根、`agents/`、没有 manifest 的 `agents/<agent-id>/`、Agent 的 `work/`、`outputs/`、`memory/` 和 `.aiteam/` 子目录。

`organization.yaml` 不属于该结构，也没有任何运行时语义。现有早期项目中的该文件必须在实施清理时移除，不能再被读取或作为兼容来源。

## 5. 启动发现与创建

### 5.1 `discover_agent(cwd)`

发现逻辑只检查当前目录本身：

| 当前目录状态 | 结果 |
| --- | --- |
| 不含 `.aiteam/agent.yaml` | 返回 `None`，按普通 Rind 会话启动 |
| 含 manifest，且不在 Team 项目内 | 按既有独立 Capsule 逻辑返回 Agent |
| 含 manifest，且在结构合法的 Team 中 | 返回绑定 Project 的 `ResolvedAgent` |
| 含 manifest，且处于 Team 中但位置或 manifest 非法 | 抛出 `ValueError`，启动失败 |

对 Team 候选目录，校验顺序为：找到祖先 `project.yaml`，验证项目 manifest，验证目录正好是 `agents/<agent-id>`，验证 `metadata.id == <agent-id>`。任何失败均不能回退为普通 Agent。

`--agent <id>` 仍然只是当前 Agent 身份断言：只有当前目录已发现合法 Agent 且 id 匹配时才成功；它绝不跳转目录。

### 5.2 `/team create`

`/team create [project-id]` 只初始化上述项目结构和 `main-agent` Capsule：

- 不改变当前 cwd；
- 不创建、迁移或切换当前 Session；
- 不创建 Team 状态目录；
- 不生成 `organization.yaml`；
- 不生成不需要的共享分类或空能力目录。

创建前仍双向检查嵌套 Team：目标目录的祖先不能已有 `project.yaml`，目标目录任一后代也不能已有 `project.yaml`。后代扫描仅用于创建，命中第一个 Team 即停止并报错。

### 5.3 二级 Agent 创建

二级 Agent 由主 Agent 的显式 `agent_create` 能力根据 Blueprint 物化为一个完整 Capsule。Blueprint 的职责是生成 manifest、提示词、需要的 Skill 和工作目录；它不登记 Agent 名册，也不创建 Session、任务或组织状态。

物化成功后，目录本身即为注册结果。手工复制一个同样合法的 Capsule 具有完全相同的发现效果。非法或不完整目录不会进入主 Agent 的可用 Agent 清单，也不能被 `delegate` 调用。

## 6. 轻量 Agent 清单

主 Agent 初始化时扫描 `agents/` 的直接子目录，仅收集结构合法 Capsule 的：

```text
id / name / description
```

该清单作为临时运行说明注入主 Agent，不落入 Session 历史，不构成持久 Organization，也不包含 Agent 的完整 prompt、Skill 或会话摘要。它的唯一作用是帮助主 Agent按专长选择 `delegate` 目标。

清单没有“激活状态”。它允许主 Agent理解有哪些专长，但工具执行时仍必须重新按目录和 manifest 校验目标，避免陈旧清单成为授权来源。

## 7. 唯一协作入口：`delegate`

`delegate` 是主 Agent专有 builtin tool，也是唯一的跨 Agent 执行入口：

```json
{
  "agent_id": "factor-agent",
  "task": "检查当前因子研究的进展，说明已发布结果与阻塞。",
  "mode": "inspect"
}
```

参数含义：

- `agent_id`：当前 Team 目录中一个合法的直接 Agent id；
- `task`：完整、可独立执行的任务说明；
- `mode`：`execute` 或 `inspect`，默认 `execute`。使用具名模式而不是含义模糊的布尔值。

工具不接受路径、任意 prompt 文件、旧 task id、会话 id 或后台参数。

### 7.1 `mode: "execute"`

这是正常的委派任务：

1. 重新解析目标 Capsule，并取得目标工作区锁；
2. 在既有用户级 Session Store 创建新的 `delegated_task` Session；
3. Session 绑定目标 `workspace_root`、`project_id`、`owner_agent_id` 和父 `parent_session_id`；
4. 用目标 Agent 的 prompt、Skill、权限和 cwd 运行任务；
5. 父 Agent 阻塞等待完成，收到普通 tool result 后继续 sampling。

每次执行委派都创建新 Session，不提供 task 恢复或共享上下文 fork。Agent 的现状应由它重新检查工作目录，而不是依赖一次旧委派的聊天上下文。

### 7.2 `mode: "inspect"`

这是“问目标 Agent 现在怎样”的只读检查，不是 Agent 消息：

1. 目标 Agent 在自己的当前目录和 `shared/` 中检查实际文件；
2. 它不创建子 Session，不写文件，不产生跨轮状态；
3. 结果直接作为父会话的 tool result 保存。

检查模式使用受限工具权限，任何写入尝试均失败。它同样取得工作区锁，因此不会读到另一场写入中的半成品。

### 7.3 统一返回结果

两种模式都返回短小、稳定的结构：

```json
{
  "agent_id": "factor-agent",
  "status": "completed",
  "summary": "完成因子回测并发现两项待确认假设。",
  "published_paths": ["shared/factor-backtest.md"],
  "session_id": "..."
}
```

`status` 只表示这次工具调用的结果，可取 `completed` 或 `blocked`；它不是可持久化的 Agent 状态。`session_id` 仅在 `execute` 时出现。`published_paths` 只能指向 `shared/` 内的稳定产物。结果正文应有固定上限，促使主 Agent在需要证据时读取已发布文件，而不是把子 Agent 全部推理塞进父上下文。

工具调用和返回结果由现有父 Session 的 tool call/result 机制持久化。不得额外建立 Team Message、Delivery、Event 或 Task 记录。

## 8. 直接对话与“拉齐”

用户可以直接进入：

```text
<project-root>/agents/factor-agent/
```

并以该 Agent 身份创建普通 direct Session。该 Session 与主 Agent发起的委派 Session 是两份独立会话；它们不会自动合并，也不存在“某一方的大脑自动同步给另一方”。

正确的拉齐方式只有两条：

1. 重要进展写入该 Agent 自己的工作文件，并将需跨 Agent使用的稳定结论发布到 `shared/`；
2. 主 Agent需要最新情况时调用 `delegate(..., mode: "inspect")` 或发起新的执行委派，由目标 Agent自行检查这些文件。

这比主 Agent直接读取所有二级 Agent 私有目录更清晰：主 Agent得到的是拥有该专长和上下文的 Agent 的解释，项目可以依赖的证据则是已发布的文件。用户仍可通过操作系统直接查看任何自己有权限查看的目录，但这不应成为 Runtime 的正常协作路径。

二级 Agent在直接会话中完成对团队有价值的工作时，应在结束前物化结论；仅留在会话文本中的内容不保证被其他 Agent看见。

## 9. 并行、锁与失败语义

每个 Agent 工作区在同一时刻只允许一个运行中的 turn。direct Session、`delegate execute` 和 `delegate inspect` 共用同一把用户级短期锁：

```text
~/.rind/locks/<project-id>/<agent-id>.lock
```

锁只保护运行期间的工作区一致性，不记录 Team 历史。任何入口无法立即获得锁时直接返回“Workspace is busy”，不排队、不重试、不创建后台记录。

主 Agent在一个回合中发出的多个、目标不同的 `delegate` 调用可以由 Runtime 并行执行；父回合等待全部结果。主 Agent必须避免让并行任务写同一个 `shared/` 文件。对同一 Agent 的并发调用受锁拒绝。

取消父回合时，正在进行的委派被取消并在 `finally` 中释放锁。模型错误、工具错误或取消按现有 tool error 语义回到父会话；不产生补偿任务、重试队列或持久“failed Agent”状态。

第一版没有后台委派。只有当“父 Agent不需要等待结果”成为明确且独立的产品需求时，才重新评估后台 Job、通知和冲突模型。

## 10. Prompt 与权限边界

主 Agent提示词只增加以下职责：根据轻量 Agent清单选择专长，使用 `delegate`，将工具结果视作说明并在需要时核验 `shared/` 中的文件。它不直接读取二级 Agent私有目录，也不假设某个二级 Agent的旧 Session代表当前项目状态。

二级 Agent在 `execute` 模式下的提示词要求：先检查当前工作区，完成明确任务，将稳定可复用结果发布到 `shared/`，并返回精炼结论与发布路径。需要用户或主 Agent决策时返回 `blocked`，不建立反向消息通道。

`inspect` 模式提示词要求：只检查并报告，不使用写入工具，不改变文件。二级 Agent没有 `delegate` 工具，故不存在无限嵌套或二级 Agent私自扩张任务树的路径。

所有 Team Agent的文件权限只覆盖自己的 Agent 根和 `shared/`。其他 Agent根目录不应列入其 read 或 write 根。

## 11. 必须清理的早期实现

以下内容与本设计冲突，实施时必须删除或替换，而不是保留兼容分支。

| 现有内容 | 清理结果 |
| --- | --- |
| `.aiteam/organization.yaml` 及其名册、角色、关系 | 停止生成、读取和校验；成员由直接子目录 Capsule 扫描决定 |
| `agent/application/organization/` 的 model 和 coordinator | 整个组织消息/状态控制面删除 |
| `agent/infrastructure/persistence/json_team_state_store.py` 及相关 store 协议 | 删除；不再维护 `agent_states.json`、`messages.jsonl`、`deliveries.jsonl`、`events.jsonl` |
| `~/.rind/teams/<project-id>/` | Runtime 不再创建或读取；旧早期数据不迁移、不参与启动 |
| `TeamRuntimeContext`、`TeamMember`、Team store 容器注入 | 删除；替换为按需解析 Project、Capsule 和轻量 Agent清单 |
| `/team list`、`/team send`、`/team pause`、`/team resume`、`/team show` | 删除；`/team` 仅保留 `create` |
| `agent_states`、消息投递、事件轮询、inbox 注入、Agent pause/resume | 删除；一次委派的结果只在父 tool result 中表达 |
| 以 task id 恢复、Task 表、Task 图、Worker 队列、后台唤醒 | 不实现 |
| `/team create` 的 Session handoff、cwd 切换、main-agent Session 自动创建 | 保持删除，不得恢复 |
| 默认 `shared/datasets`、`artifacts`、`reports`、`decisions` 和空 Skill/Workflow 目录 | 不再自动创建 |

`agent/infrastructure/team.py` 应被收敛为项目 manifest、Capsule 加载、严格发现、直接子目录扫描和项目初始化；不再拥有组织名册、状态根、`organization.yaml` 或状态冲突逻辑。

早期生成的 Team 项目没有迁移兼容层。实施清理后，旧 `organization.yaml` 与旧用户级 Team 状态不会被读取；示例或测试项目应重新按本标准结构创建。这样可以避免旧控制面继续影响新行为。

## 12. 最小实施顺序与验收

### 阶段一：收紧文件模型

1. 从 Team 初始化、加载和发现中移除 `organization.yaml` 与 Team state root；
2. 将 `project.yaml` 收敛为 `main_agent`、`agents_root`、`shared_root`；
3. 保留精确 cwd 发现与严格 manifest/目录名校验；
4. `/team create` 仅生成最小目录，不改变当前会话。

验收：项目根和 Agent 子目录都按普通 Rind启动；只有精确 Agent根绑定 Capsule；复制合法 Agent目录后无需注册即可被发现。

### 阶段二：删除组织控制面

1. 删除 Team state store、organization coordinator、模型、容器注入和轮询；
2. 删除除 `/team create` 外的全部 Team slash command；
3. 删除与消息、投递、状态、事件、任务恢复有关的测试和前端展示。

验收：启动和 Session 创建不访问 `~/.rind/teams`，项目目录和 Session Store 中没有 Team Message/Task/Event 记录。

### 阶段三：实现 Capsule 委派

1. 为主 Agent注册 `delegate`，为主 Agent初始化轻量 Agent清单；
2. 实现 `execute` 的新子 Session、父子 Session关联、目标 cwd 和普通 tool result；
3. 实现 `inspect` 的无子 Session只读执行；
4. 为 direct turn 与两种委派接入同一工作区锁；
5. 禁止二级 Agent获得 `delegate`，并限制跨 Agent私有目录访问。

验收：

- 一次 `execute` 委派创建一份正确绑定的 `delegated_task` Session；
- `inspect` 不创建子 Session也不能写文件；
- 父 Session保存标准 tool call/result；
- 同一 Agent的 direct 和委派冲突立即失败，不同 Agent可并行；
- 子 Agent发布 `shared/` 文件后，主 Agent能按返回路径核验；
- 二级 Agent不能向主 Agent发送消息，也不能嵌套委派。

### 阶段四：实现显式 Agent创建

以独立的 `agent_create` Blueprint 物化能力完成二级 Capsule 创建。验收标准是物化结果可被严格发现、可直接从目录启动、可进入主 Agent清单、可由 `delegate` 调用，并且没有任何额外注册文件或运行时状态。

## 13. 明确不做的事

- 不做 Agent 对 Agent 聊天、收件箱、广播、事件总线或回执；
- 不做组织图、固定 roster、岗位状态、在线状态或暂停状态；
- 不做项目内数据库，也不为 Team引入用户级数据库；
- 不做后台 Worker、异步任务、通知、轮询、重试或任务队列；
- 不做子 Agent会话的自动摘要、自动同步或上下文拼接；
- 不让主 Agent从默认目录猜测或切换到某个 Agent；
- 不为旧 Team结构保留兼容运行路径；
- 不把 Rind包装成与 Codex/OpenCode 同质的通用多 Agent调度框架。

这套边界保留了 Team真正需要的能力：专长 Agent可长期存在、用户可随时直接进入、主 Agent可同步委派、工作成果可验证；同时避免把会话、消息和状态复制成另一套项目级操作系统。
