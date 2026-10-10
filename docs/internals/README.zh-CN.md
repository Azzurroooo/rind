# Inside Rind：架构与 Worker 内核文档地图

English | [简体中文](README.md)

本系列包含 **9 组、52 篇**中文机制文档。每篇从一个问题和一张 Mermaid 图进入，解释当前实现、关键顺序与保证范围，并附源码和测试入口。以本次整理所依据的仓库源码为准；测试链接用于追溯契约，不代表全部测试在此次文档整理中运行。这里的“无状态”特指**持久会话状态以磁盘为准**：Worker 仍持有运行中的任务、取消信号、队列和共享资源。

## 整体叙事

~~~mermaid
flowchart LR
    S["Surface<br/>CLI · Desktop · Web · Mobile · Gateway"] --> P["协议与传输"]
    P --> W["Worker Server<br/>会话访问 · 执行协调"]
    W --> R["执行内核<br/>AgentRuntime · TurnRunner"]
    R --> C["上下文<br/>组装 · 预算 · 压缩"]
    R --> M["模型适配<br/>流式输出"]
    R --> T["工具系统<br/>调用 · 结果 · 后台任务"]
    C --> D["持久事实<br/>会话 · 工具 · 任务日志"]
    T --> D
    D --> W
    W --> E["事件 · 重放 · 快照"]
    E --> P
~~~

贯穿各篇的不是“有哪些类”，而是五组设计张力：

| 设计张力 | Rind 的回答 | 重点文章 |
| --- | --- | --- |
| 多入口与单一执行语义 | Surface 处理交互，Worker 用统一协议承接执行。 | Surface/Worker、统一协议 |
| 长会话与低常驻负载 | 磁盘保存会话事实，执行容器只在需要时存在。 | 资源所有权、会话生命周期 |
| 完整历史与有限上下文 | 保留原始记录，按需投影、估算和压缩模型视图。 | 消息投影、ContextManager、压缩交接 |
| 长任务与单轮对话 | 进程事实先落盘，通知与自动续接再跨回合交付。 | 后台任务日志、自动续接 |
| 丰富工具与稳定接口 | ToolSpec、结构化结果和双投影隔离工具差异。 | 工具注册、调用链、工具结果 |

整套文档从五个角度看同一个系统，文章只有一个归属，其他角度用阅读路线交叉引用，避免重复讲解：

| 角度 | 读者想回答的问题 | 对应章节 |
| --- | --- | --- |
| 空间结构 | 组件放在哪里，谁依赖谁，谁拥有资源？ | 00、01、07 |
| 时间过程 | 一次请求、一个回合、一个后台任务如何开始和结束？ | 01、05、07 |
| 数据形态 | 原始历史、模型上下文、事件、快照分别是什么？ | 02、03 |
| 能力扩展 | 如何接入模型、工具、Skill、Team 和新 Surface？ | 02、04、05、06、07 |
| 可靠性 | 断连、取消、重启、超限或失败后还能保证什么？ | 01、03、08 |

## 00 · 系统全景与边界（5 篇）

先建立地图，再进入实现。重点是“一个引擎，多种入口”和显式依赖边界。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [一张图看懂 Rind](00-architecture/system-map.zh-CN.md) | 一次请求会穿过哪些层，哪些状态会留下来？ | 全局结构图 |
| [Surface 与 Worker](00-architecture/surface-worker.zh-CN.md) | 输入、渲染、协议、执行各由谁负责？为何能复用内核？ | 进程边界图 |
| [分层与装配根](00-architecture/layers-and-composition.zh-CN.md) | domain、application、runtime、infrastructure 怎样通过 bootstrap 连接而不反向依赖？ | 依赖图 |
| [统一协议](00-architecture/protocol.zh-CN.md) | request、response、event、capability、method 如何形成稳定契约？ | 协议结构图 |
| [同协议的不同传输](00-architecture/transports.zh-CN.md) | stdio、WebSocket、Electron preload 的连接与关闭语义有何不同？ | 传输拓扑图 |

## 01 · Worker 与执行内核（9 篇）

从资源生命周期走到单轮执行，再走到事件、取消与恢复。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [Worker 的一生](01-runtime/worker-lifecycle.zh-CN.md) | 启动、初始化、请求、关闭分别创建和释放什么？ | 生命周期时序图 |
| [低负载的关键](01-runtime/resource-ownership.zh-CN.md) | Worker 共享资源、会话落盘、执行容器按需创建和空闲释放如何配合？ | 资源所有权图 |
| [每会话一条执行通道](01-runtime/execution-coordinator.zh-CN.md) | 用户回合、目标检查点、任务续接怎样竞争同一个执行位置？ | 仲裁状态图 |
| [一个回合的内循环](01-runtime/turn-loop.zh-CN.md) | 输入如何经历上下文、模型采样、工具调用，直到终止？ | 时序图 |
| [流式模型边界](01-runtime/model-stream.zh-CN.md) | 增量文本与工具参数如何解析、限流、合批并保持顺序？ | 有界队列数据流图 |
| [Steering 与 Follow-up](01-runtime/input-queues.zh-CN.md) | 采样前插话、完成后续接、撤回和提升各在何时生效？ | 双队列时序图 |
| [事件系统](01-runtime/event-system.zh-CN.md) | 域事件、协议封装、durable/incremental、session/turn ID 各承担什么职责？ | 事件流图 |
| [重放与重新订阅](01-runtime/replay-and-resubscribe.zh-CN.md) | 历史光标、当前回合快照、后台任务快照如何在断连后拼回完整状态？ | 断线重连时序图 |
| [取消、失败与续跑](01-runtime/cancellation-and-recovery.zh-CN.md) | 取消如何跨模型/工具/进程传播？未闭合工具调用怎样恢复且不重复执行？ | 失败分支图 |

## 02 · 上下文、记忆与压缩（7 篇）

这一组回答“模型究竟看到了什么”，把上下文组装与磁盘历史区分开。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [指令从哪里来](02-context/prompt-assembly.zh-CN.md) | 基础系统提示、RIND.md、Goal/Team 指令、Skill 目录与临时消息怎样进入请求？ | 提示来源叠层图 |
| [ContextManager](02-context/context-manager.zh-CN.md) | 持久消息、运行时注入、Skill、待处理输入如何构成最终模型消息？ | 组装流水线图 |
| [上下文预算](02-context/context-budget.zh-CN.md) | 本地估算、服务端用量锚点、窗口余量和 context inspect 怎样避免盲目塞满？ | 预算分配图 |
| [何时压缩](02-context/compaction-triggers.zh-CN.md) | 手动、自动、上下文超长恢复为何共享管线，却由不同调用者决定是否继续采样？ | 触发状态图 |
| [压缩交接](02-context/compaction-handoff.zh-CN.md) | 历史摘要、原样保留的最近消息、工具配对、失败回退与边界校验怎样保证可续接？ | 压缩前后对照图 |
| [Skill 的渐进披露](02-context/skills.zh-CN.md) | 元数据发现、作用域覆盖、显式激活、快照持久化如何避免每轮加载全文？ | 发现与激活时序图 |
| [图片进入上下文](02-context/image-input.zh-CN.md) | 用户上传与工具图片如何快照、存储、校验能力并适配模型请求？ | 图片数据流图 |

## 03 · 持久化与事实来源（5 篇）

分别解释“盘上存什么”和“运行时怎样解释这些记录”，不把聊天记录等同于模型上下文。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [会话落盘结构](03-persistence/session-store.zh-CN.md) | meta、messages、tool_calls、compactions、索引与附件各记什么？ | 存储布局图 |
| [原始历史到模型视图](03-persistence/message-projection.zh-CN.md) | 内部消息、压缩边界、工具结果、推理内容如何投影而不改写原始记录？ | 投影管线图 |
| [会话的创建、恢复、分叉与删除](03-persistence/session-lifecycle.zh-CN.md) | 启动草稿为何延迟落盘？fork 复制什么，哪些运行中任务不随之复制？ | 生命周期状态图 |
| [后台任务日志](03-persistence/task-journal.zh-CN.md) | 追加事实、Worker lease、去重、重启后的 lost 状态怎样支撑恢复？ | 日志与恢复时序图 |
| [用量账本](03-persistence/usage-ledger.zh-CN.md) | 采样用量、压缩用量、会话统计与汇总报告的来源分别是什么？ | 数据血缘图 |

## 04 · 工具系统（8 篇）

先讲统一调用链，再讲不同工具为什么需要不同的资源与结果契约。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [ToolSpec 与注册表](04-tools/tool-registry.zh-CN.md) | schema、参数归一化、可用性、执行器如何组成可扩展工具边界？ | 工具装配图 |
| [一次工具调用](04-tools/tool-call-lifecycle.zh-CN.md) | 模型输出如何解析、校验、执行、归一化、落盘、发事件，并在恢复时去重？ | 完整时序图 |
| [同一结果的两种视图](04-tools/tool-results.zh-CN.md) | 结构化结果、模型可见内容、终端展示、完整落盘输出、截断与分页为何分开？ | 双投影数据流图 |
| [文件读取与修改](04-tools/file-tools.zh-CN.md) | 分页读取、glob/grep、单点 edit、逐路径写队列、暂存后替换如何协作？ | 读写路径图 |
| [受控进程与后台执行](04-tools/shell-tools.zh-CN.md) | bash、task_control、进程树、输出游标、取消和超时怎样受 Worker 管理？ | 进程状态图 |
| [Web 搜索与抓取](04-tools/web-tools.zh-CN.md) | 搜索、抓取、会话复用与有界内容如何保持工具契约？ | 请求数据流图 |
| [工具中的用户问答](04-tools/user-questions.zh-CN.md) | 执行暂停、协议答复和无交互 one-shot 之间是什么关系？ | 问答时序图 |
| [计划不是对话](04-tools/plan.zh-CN.md) | update_plan 的会话文件、快照和压缩交接怎样保持计划可见？ | 计划状态图 |

## 05 · 长任务、目标与协作（5 篇）

这些机制跨越单个模型回合，是“Agent 能持续做事”的主体。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [后台任务状态机](05-autonomy/managed-tasks.zh-CN.md) | 命令返回、进程继续、手动读取、等待释放与最终状态如何分离？ | 任务状态图 |
| [自动续接](05-autonomy/task-notifications.zh-CN.md) | 工具结果先提交、任务完成再投递通知、模型消费后再确认，如何避免丢失或重复？ | 提交—通知—消费时序图 |
| [持久 Goal](05-autonomy/goals.zh-CN.md) | active/paused/blocked/complete、检查点、完成证据与续接门控怎样工作？ | Goal 状态图 |
| [Team](05-autonomy/teams.zh-CN.md) | Team 如何作为注册表关系存在，Worker 与控制面如何分工？ | 控制面结构图 |

## 06 · 模型与供应商（3 篇）

解释模型差异如何止于适配层，而不是向执行内核渗透。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [统一模型接口](06-models/provider-adapters.zh-CN.md) | OpenAI Chat/Responses、Anthropic、Gemini 的消息、工具、流式事件与取消如何归一？ | 适配层结构图 |
| [能力与目录](06-models/model-catalog.zh-CN.md) | 内建定义、远端刷新、缓存有效期、context window 与 image_input 如何决定可用能力？ | 能力解析图 |
| [配置与凭证](06-models/authentication-and-settings.zh-CN.md) | Provider 登录、设置来源、模型选择与密钥保存的职责边界是什么？ | 配置流图 |

## 07 · Surface 如何复用内核（6 篇）

围绕 Surface/Worker 的交界解释输入、状态和连接；同时保留源码启动、配置和构建入口。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [交互式 CLI](07-surfaces/interactive-cli.zh-CN.md) | Node Surface 如何维护输入、投递请求、消费事件和稳定渲染？ | CLI—Worker 时序图 |
| [rind run](07-surfaces/one-shot.zh-CN.md) | completion_scope=request 如何等待本次任务及续接；stdout、stderr、日志为何分流？ | 请求作用域图 |
| [rind send](07-surfaces/send.zh-CN.md) | 另一个终端如何找到目标会话，忙碌和空闲时如何投递输入？ | 跨进程时序图 |
| [Desktop](07-surfaces/desktop.zh-CN.md) | Electron main、preload、renderer 与共享的存活 Worker 如何隔离？ | 进程拓扑图 |
| [Web 与 Mobile](07-surfaces/web-and-mobile.zh-CN.md) | WebSocket、重连、远程访问与 Capacitor 容器如何复用 Web Surface？ | 连接拓扑图 |
| [消息网关](07-surfaces/gateway.zh-CN.md) | 渠道适配、会话路由、去重、事件光标和 Worker 连接怎样组合？ | 网关数据流图 |

## 08 · 横切约束与工程验证（4 篇）

把设计的不变量、边界和证据讲清，而不是只展示顺利路径。

| 文章 | 阅读问题 | 主图 |
| --- | --- | --- |
| [信任边界](08-engineering/trust-boundaries.zh-CN.md) | 文件路径、Team 私有空间、凭证、外部网页与进程输出在哪些边界被约束？ | 信任边界图 |
| [有界系统](08-engineering/limits-and-backpressure.zh-CN.md) | 流队列、事件队列、上下文、工具输出和后台进程分别在哪一层限流？ | 限额位置图 |
| [看见内核](08-engineering/observability.zh-CN.md) | context inspect、事件、用量、trace、debug 如何定位一次回合的问题？ | 观测数据流图 |
| [如何验证设计](08-engineering/verification.zh-CN.md) | 协议 golden fixture、单元与 fake-provider 进程测试、虚拟终端、手动验收分别证明什么？ | 测试分层图 |

## 推荐阅读路线

| 读者 | 顺序 |
| --- | --- |
| 第一次认识 Rind | [系统地图](00-architecture/system-map.zh-CN.md) → [Surface/Worker](00-architecture/surface-worker.zh-CN.md) → [Worker 资源所有权](01-runtime/resource-ownership.zh-CN.md) → [单轮内循环](01-runtime/turn-loop.zh-CN.md) → [上下文组装](02-context/context-manager.zh-CN.md) → [会话存储](03-persistence/session-store.zh-CN.md) → [事件系统](01-runtime/event-system.zh-CN.md) |
| 要改 Worker 内核 | [分层装配](00-architecture/layers-and-composition.zh-CN.md) → [执行协调](01-runtime/execution-coordinator.zh-CN.md) → [回合内循环](01-runtime/turn-loop.zh-CN.md) → [工具调用](04-tools/tool-call-lifecycle.zh-CN.md) → [取消与恢复](01-runtime/cancellation-and-recovery.zh-CN.md) → [重放](01-runtime/replay-and-resubscribe.zh-CN.md) |
| 要理解“巧思” | [低负载资源所有权](01-runtime/resource-ownership.zh-CN.md) → [压缩交接](02-context/compaction-handoff.zh-CN.md) → [双视图工具结果](04-tools/tool-results.zh-CN.md) → [任务提交/通知/消费](05-autonomy/task-notifications.zh-CN.md) → [one-shot 请求作用域](07-surfaces/one-shot.zh-CN.md) |
| 要接新入口或模型 | [统一协议](00-architecture/protocol.zh-CN.md) → [传输](00-architecture/transports.zh-CN.md) → [事件与重放](01-runtime/replay-and-resubscribe.zh-CN.md) → [Provider 适配或对应 Surface](06-models/provider-adapters.zh-CN.md) |

## 用一个场景串起全篇

用户要求“运行测试，分析失败并修复”：Surface 发出 prompt → 执行协调器装配会话容器 → ContextManager 构造模型视图 → 模型提出 bash → Worker supervisor 管理进程 → 初始工具结果提交 → 长命令交回控制权后，回合容器可释放 → 任务终态写日志 → 通知门控发起续接 → 新容器读取会话继续处理。历史太长时，压缩只替换模型视图；客户端断线时，重放负责重建显示。

这条链上最值得留意的是三个顺序：**事实先落盘，再交付通知；先确定资源拥有者，再决定何时释放；保留原始历史，再构造有限视图。** 各篇分别说明这些顺序成立的条件与例外。

相邻专题刻意分工：协议讲公开契约，传输讲连接；Shell 讲进程控制，后台任务讲跨回合语义；任务日志讲存储事实，自动续接讲何时消费；事件讲实时通知，重放讲状态重建；压缩触发讲决策，压缩交接讲保真与恢复。

[返回文档入口](../README.zh-CN.md) · [返回项目](../../README.zh-CN.md)
