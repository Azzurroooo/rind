# Rind 低负载优化与升级方案

日期：2026-09-28。状态：源码调研与局部实验已完成；实现及四产品整机评测尚未执行。

本次交付仅为方案文档，不修改应用、协议、测试、依赖或发布配置。文中的新接口、目录、预算和测试均为后续实施建议，不能当作已经存在的能力或已经通过的验收。

## 1. 目标与结论

目标是在保留丰富终端展示、流式响应、输入流畅度、后台任务自动续接和完整历史访问的前提下，降低 Rind 的 CPU 时间、内存驻留、分配量、无效唤醒和终端输出量。优先消除重复工作，再决定是否需要改变渲染架构；不以隐藏内容、丢弃事件、关闭动画、延迟响应或重写语言来换取漂亮数字。

最值得先实施的工作是：

1. 缓存已完成工具块的解析和渲染结果，并为纯 ASCII 文本增加宽度计算快路径。这两项有源码和局部实验的直接支持。
2. 让状态栏刷新只更新变化区域，避免每次呼吸或秒数变化都遍历、拼接、重置 ANSI 和比较整段历史。
3. 将动画与内容刷新统一到按需调度，减少重复计时器；输入保留高优先级。
4. 在明确的单一边界合并流式文本事件，完善队列与终端写入背压；保证取消和完成事件不被堵住。
5. 根据真实 Python 调用栈再优化取消等待、序列化和会话快照，不把“Python 占用 19%”直接解释为正常开销。
6. 对长会话建立内存预算与历史按需加载，最后通过统一场景与评分体系检验效果。

Codex、Pi、Crush 的共同启示是：**减少每次刷新需要计算的内容，比单纯降低帧率更重要**。三者也各有无界队列、重新解析或缓存复杂度等限制，不能整套照搬。

“最优”在本文中指：固定版本、固定硬件、相同功能与工作负载下，Rind 通过体验门槛，在公共场景取得领先的综合分，并尽量进入 CPU、内存、延迟的 Pareto 前沿。它不代表未经测量就承诺在所有平台、所有任务、所有指标上胜过其他实现。

### 1.1 实施硬约束

以下约束适用于全部阶段，也适用于基准工具与测试辅助代码。性能目标不能豁免这些要求；后文的缓存、索引、调度和接口建议只有在满足这些约束时才可实施。

1. **功能与体验完整，采用最小可行实现。** 轻量化同时约束运行负载和实现复杂度。保留必要功能与易用性，以能解决已确认问题的最简单实现交付；不缩减功能换低负载，也不因追求扩展性写冗长实现。
2. **严格避免冗余逻辑与字段，如无必要，勿增实体。** 禁止为“以防万一”预留未使用的变量、接口、分支、配置项或状态。每项新增内容必须有当前实际调用方或可验证用途。命名准确表达职责、作用域和单位，同一概念保持同名，不同概念避免混名；代码无需依赖注释补救含糊命名。能由权威状态廉价推导的值不重复存储；确需缓存的派生结果必须有热点证据、明确失效条件和容量边界。
3. **边界显式，依赖单向，同类同构。** 模块仅通过显式接口通信，不跨模块访问或修改内部状态。A 依赖 B 时 B 不得反依赖 A；若出现环，将确实共用的最小契约或逻辑下沉到双方可依赖的公共层，不建立空泛的通用框架。多数据源、handler、provider 等同类功能共用接口规范。禁止全局可变状态、隐藏初始化顺序和隐式副作用，依赖必须显式传入。没有必要不增加抽象层、设计模式或框架，能用函数解决的不写成类。
4. **替换必须伴随清理。** 修改过程中同步删除被替代的逻辑、字段、接口、导入、分支和测试辅助代码，修复本次路径中的歧义与低效片段。不能让新旧实现永久并存，也不能用兼容或回滚的名义保留没有实际使用者的代码。实际仍支持的旧协议兼容路径须保留明确契约和回归覆盖。

P0–P7 是按证据推进的路线，不是必须堆齐的架构清单。每阶段先以最小改动验证效果；现有接口足够时不扩展接口，现有状态足够时不增加字段，现有函数足够时不增加类。达到目标后，不继续实施缺乏实际收益依据的复杂方案。

## 2. 证据范围与版本基线

### 2.1 固定源码版本

| 产品 | 本次查看的仓库 | 固定提交 | 备注 |
|---|---|---|---|
| Rind | 当前工作区，`feature/bash-task-upgrade` | `e7c02e6cd36bf94bea1ca93fc7ff7ddd4ecb4fde` | 本文路径与分析基于此提交 |
| Codex | [openai/codex](https://github.com/openai/codex) | `e6f4af1d92bbfadcc49217006c930f2a760f1cc8` | Rust CLI；不把 workspace 的 `0.0.0` 当发布版本 |
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) | `6f7551516b84278eb9da1c340c8e7bc66be1a6ba` | 查看版本中的 coding-agent 包为 `0.87.1` |
| Crush | [charmbracelet/crush](https://github.com/charmbracelet/crush) | `ae848542495815e127e248a313bbe79d38772d5c` | Go，Bubble Tea v2；以 SHA 为准 |

Pi 的实际来源以上表为准，不用旧仓库名推断当前实现。后续任何竞品升级都需创建新的比较批次，不能把不同提交的结果混进同一排行榜。

### 2.2 证据等级

- **源码事实**：在固定提交中确认的路径、调用和缓存行为；能证明机制，不能单独证明实际 CPU 百分比。
- **局部实测**：本次对 Rind 组件或函数的受控调用；能定位重复工作，不能代表整个应用或其他产品。
- **待剖析假设**：根据代码识别的风险，需 CPU profile、分配采样或队列指标验证后再实施。
- **设计目标**：后文的阈值、评分和验收预算；不是本次已取得的成绩。

### 2.3 对此前负载解释的修正

此前进程采样没有形成严格的单调时钟测量窗口，也没有相同场景的调用栈证据。生命周期 CPU 累计时间或累计平均占用不能作为当前 turn 的瞬时负载。因此，此前“Python 约 19%”只能视为需要重新测量的观察，不能据此认定正常，也不能直接归因于 flush、JSON 或取消机制。

统一计算方式：

```text
单核 CPU% = 100 × Δ(用户态 CPU 秒 + 内核态 CPU 秒) / Δ单调时钟秒
整机 CPU% = 单核 CPU% / 逻辑处理器数量
```

单核 CPU% 可以超过 100%。本机为 12 个逻辑处理器，不能用 6 个物理核心代替分母。Python、Node、任务子进程和终端模拟器需要分别测量。

Rind 已经有逐行 diff 和变化区域写入，不能描述为“每一帧都向终端重写全屏”。目前更明确的问题发生在 diff **之前**：全树 render、历史行拼接、工具结果重复处理和全量行比较。

## 3. Codex：按需帧、稳定内容与可见区缓存

### 3.1 调度并不等于持续跑满帧率

`tui/frame_requester.rs` 使用请求驱动的调度器，把多个请求合并到最早待执行时间；没有请求时不持续生成帧。`tui/frame_rate_limiter.rs` 的最小帧间隔约 8.33 ms，即上限约 120 FPS。这说明高帧率上限与低空闲负载并不矛盾，关键是有没有变化，以及一帧要做多少工作。[C1][C2]

边界：请求通道采用 unbounded mpsc，不能由此声称 Codex 所有队列都有限。Rind 应借鉴合并请求和按需唤醒，而不是照搬通道实现或直接设为 120 FPS。

### 3.2 流式渲染拆分稳定前缀与可变尾部

`streaming/controller.rs`、`streaming/render.rs` 将已稳定的 Markdown 块和仍在变化的尾部分开。已完成块可以复用；开放的代码围栏、表格、引用链接等需要更谨慎的提交和失效规则。[C3][C4]

`markdown_stream.rs` 维护源文本提交边界，不能把“按换行提交源文本”直接等同于“所有 Markdown 只做增量解析”。引用定义等内容可能改变更早部分的解释，必须保留正确性回退。

`streaming/chunking.rs` 在平滑输出与追赶积压之间切换：例如积压达到 8 行或最早内容等待 120 ms 时进入追赶；严重积压阈值为 64 行或 300 ms。退出具有滞后条件，避免来回切换。[C5]

对 Rind 的启示是不要用固定“一帧只显示一点”制造落后。正常流可以合并到适当频率，积压时应扩大一次处理量，完成时及时排空。

### 3.3 缓存有明确键与容量边界

`history_cell/markdown_render_cache.rs` 为已完成消息保留渲染缓存，键包含宽度、列表间距、主题版本、终端颜色等影响输出的条件。[C6]

`transcript_view/layout.rs` 的布局缓存有 64 项、8 MiB 文本预算，并允许单个超大条目例外；这不是整个 Codex 的 8 MiB 内存上限。阅读位置由稳定内容锚点支持，以应对补入历史和重排。[C7]

Codex 同时存在 owned transcript 和原生 scrollback 相关路径，不能简单概括为“全部使用虚拟列表”。Rind 应先复用稳定布局与限制缓存，再独立评估是否改变现有终端历史语义。

## 4. Pi：轻量组件、输入优先与分配控制

### 4.1 请求合并与即时输入

`packages/tui/src/tui.ts` 使用 16 ms 最小刷新间隔，通过 nextTick 和定时器合并请求。输入可以走 immediate render，取消旧的节流等待。源码明确考虑了 Windows 上 `setTimeout(0)` 可能额外等待约 16 ms 的现象。[P1]

Rind 同样使用约 16 ms 调度，因此“16 ms 太快”不足以解释两者负载差异。应关注输入等待、重复 render 和更新范围，而不是只调一个 FPS 参数。

语义差异也需保留：Pi 的 force 路径会重置部分渲染状态；Rind 的 force 仅绕过节流，`replayAll()` 才负责完整重放。不能因为借鉴 Pi 就改变 Rind 的 force 契约。

### 4.2 简单缓存有效，但不自动意味着全链路增量

`components/text.ts` 与 `components/markdown.ts` 复用文本和宽度未变时的行结果。Markdown 文本变化后仍可能对整个规范化文本执行 lexer，因此不能说 Pi 始终只解析新 token。[P2]

`layout.ts` 的渲染缓存用于同一帧内共享测量和渲染结果，是每帧新建的缓存；`scroll-view.ts` 仍可能先调用整个 child.render。存在 ScrollView 并不等于所有工作都是 O(可见行数)。[P3]

`tui-alt-screen.ts` 对屏幕行做差异输出，并把同步输出合成一次终端 write。这可减少闪烁和系统调用，但不会自动消除输出前的所有计算。

### 4.3 字符宽度与分配量值得单独测量

`utils.ts` 有可打印 ASCII 快路径、共享分词器及容量为 512 的非 ASCII 宽度缓存。[P4] Rind 当前的文字宽度热点与此直接相关，但新增缓存应属于渲染器实例，不能引入用户明确禁止的全局可变状态。

Pi 的 `render-churn-bench.ts` 利用 V8 采样观察分配，包括随后被回收的对象；`alt-screen-large-transcript-bench.ts` 覆盖稳定帧、滚动、流式更新和 resize。[P5] 这比仅比较运行结束时 heap 大小更能发现 GC 压力。

其 AI event stream 使用双栈 FIFO 降低队列操作成本，但队列本身并无容量上限。不要把高效 FIFO 与背压混为一谈。

## 5. Crush：版本缓存、单一动画时钟与边界刷新

### 5.1 合并更新，同时保留生命周期边界

`internal/message/message.go` 的流式更新默认以 33 ms 合并持久化与 pubsub；完成、错误、取消和工具边界需要及时 flush，一致读取与退出有 Flush/FlushAll 语义。[H1]

Rind 已在消息完成等节点保存消息，并不需要为了模仿 Crush 再引入数据库或新的持久化节流层。应借鉴“可合并的更新”和“必须先结清的边界”这一划分。

### 5.2 稳定 Markdown 前缀与列表版本缓存

`ui/chat/streaming_markdown.go` 缓存可安全确认的前缀，对代码围栏、列表、表格、引用、Setext 标题等歧义采用保守边界或回退。最终应与完整渲染结果一致，而不能为了速度错误冻结内容。[H2]

`ui/list/list.go` 使用宽度和 item Version 缓存输出；状态改变时版本失效，并结合可见条目范围渲染。[H3] 这比每次状态栏更新都再次处理已完成工具更符合 Rind 的问题所在。

### 5.3 只让可见动画驱动刷新

`ui/model/chat.go` 使用统一聊天动画时钟，只更新可见 Animatable，无可见动画就停止。旧 tick 通过 generation 失效；`ui/anim/anim.go` 的时钟约 20 FPS，部分省略号每 8 tick 才变化。[H4]

不是每个工具各建一只定时器，也不是 tick 到达就一定有内容变化。Rind 可以将 Working、Waiting 呼吸和工具计时协调到一个拥有明确生命周期的控制器。

### 5.4 不照搬所有缓存与事件策略

Crush 的滚动整帧缓存最多 32 项、TTL 3 秒，包含光标状态；源码提到的内存估算不能作为本次实测。它对鼠标滚轮和移动分别合并，不能顺手合并掉键盘输入。[H5]

其 pubsub 缓冲区满时，常规更新可以丢弃；must-deliver 路径也有超时失败。这种策略不适合 Rind 的无损文本 delta、工具参数和控制事件。[H6]

应借鉴“可见内容、有效版本、明确失效”的原则，不优先复制整帧 TTL 缓存。后者容易掩盖遗漏失效，并增加内存和调试成本。

## 6. 四产品机制横向比较

本表是固定源码的机制比较，不是 CPU、RSS 或功耗排行榜。

| 维度 | Rind 当前 | Codex | Pi | Crush | Rind 决策 |
|---|---|---|---|---|---|
| 调度 | 16 ms 合并；另有状态和工具 tick | 按需请求，约 120 FPS 上限 | 16 ms，输入即时路径 | 消息更新合并与统一动画 | 先减少无效工作，再设刷新预算 |
| 完成内容 | assistant/text 有缓存；tool 未缓存 | 完成 Markdown 缓存 | 文本/宽度缓存 | item 宽度/版本缓存 | 首先补齐工具块缓存 |
| 流式 Markdown | 已有行级缓存，可变尾部仍重复处理 | 稳定块、尾部、追赶策略 | 文本变化可能全量 lexer | 安全前缀与回退 | 完善现有实现，不新建第二套解析器 |
| 历史规模 | 全树 render 与全量平铺 | 有界布局缓存与阅读锚点 | 部分布局仍先渲染整个 child | 可见条目与版本布局 | 先稳定历史分段，再考虑阅读视口 |
| 终端输出 | 已有 diff、同步写入 | 差异绘制/历史插入 | 差异绘制、单次写入 | Bubble Tea 屏幕更新 | 保留现有优势，补背压 |
| 流式队列 | 部分无界；任务队列已有界 | 请求通道有无界部分 | FIFO 高效但无界 | 部分 pubsub 允许丢更新 | 无损流与可替代快照分别处理 |
| 性能验证 | 本次发现局部高成本 | 流式/布局相关测试 | 分配与大历史基准 | idle/stream/resize/cache 基准 | 建立组件、协议、真终端三层验证 |

## 7. Rind 局部实测与适用边界

### 7.1 环境与方法

本机：Windows 10 Pro 10.0.19045，Intel i7-9750H，6 核 12 线程，约 31.8 GiB RAM；Node v22.19.0，Python 3.13.2。Node 实验设置 `NO_COLOR=1`。

实验仅在内存中导入当前组件，宽度 100，无 TTY、网络、模型调用和真实终端写入，工具动画关闭。未修改源码或留下基准脚本。后台系统活动没有完全隔离，数值用于定位量级，不能作为正式发布成绩。

静态 assistant 内容为普通文本行重复 8 次；每个完成 bash 工具包含 60 行 stdout，折叠显示。预热 5 帧，每组 5 次试验、每次 30 帧，取每帧耗时中位数。

| 内容 | 块数 | 输出行数 | 墙钟 ms/帧 | CPU ms/帧 |
|---|---:|---:|---:|---:|
| 完成 assistant | 20 | 160 | 0.013 | 0（低于采样分辨率） |
| 完成 assistant | 100 | 800 | 0.013 | 0（低于采样分辨率） |
| 完成 assistant | 400 | 3,200 | 0.044 | 0（低于采样分辨率） |
| 完成工具 | 20 | 140 | 11.738 | 12.500 |
| 完成工具 | 100 | 700 | 56.173 | 56.767 |
| 完成工具 | 400 | 2,800 | 250.726 | 250.500 |

两类内容不同，不能把这个比值解释为两种消息的公平效率排名。它证明的是：完成 assistant 已经能复用结果，而完成工具存在明显重复工作。400 个完成工具时，单次约 250 ms 的 CPU 工作遇到 300 ms 状态刷新周期，理论上就能占用约 83% 单核；这只是机制解释，不是对此前运行 PID 的追溯诊断。

### 7.2 V8 采样定位

100 个完成工具、预热后 30 次 render，共 1,238 个采样点：

| 自身采样函数 | 样本数 | 占比 |
|---|---:|---:|
| `graphemes` | 789 | 63.7% |
| `isEmoji` | 104 | 8.4% |
| `stripAnsi` | 67 | 5.4% |
| GC | 55 | 4.4% |
| `isZeroWidth` | 33 | 2.7% |
| tool-display 匿名函数 | 33 | 2.7% |
| `parseToolResult` | 29 | 2.3% |
| `shellOutputLines` | 28 | 2.3% |
| `segmentWidth` | 22 | 1.8% |

这是特定组件实验的自身采样分布，不是整个 Node 进程的完整调用占比。它支持“先缓存，后优化字宽”的实施顺序。

另一个反事实实验把 100 个块的固定宽度输出预先保存，再让容器只拼接这些行，得到约 0.00775 ms/帧。这不是生产缓存实现，未包含构建、失效、终端输出和内存成本；不能宣传为产品数千倍提速。

### 7.3 Python 取消机制局部实验

异步源产生 10,000 个 item，每个 item 执行一次 `asyncio.sleep(0)`，通过真实 `iterate_with_cancellation` 消费；5 次 process_time 中位数：

| 路径 | CPU 总时间 | 单 item |
|---|---:|---:|
| 无取消 token | 62.50 ms | 6.25 μs |
| 有 CancellationToken | 656.25 ms | 65.63 μs |

每个 item 创建读取 task、取消等待 task，再等待和回收，确有成本。但若真实吞吐为 100 item/s，这个实验量级约为 0.66% 单核，不能解释所有“19%”观察。SDK、协议序列化、上下文构建和其他活动尚未包含。优化应复用流生命周期的取消等待，不能移除取消能力。

## 8. Rind 热点与优先级

路径均相对仓库根目录；等级 A 为源码与局部实测支持，B 为源码确认、整机收益待测，C 为待 profile 决定。

| 优先级 / 证据 | 位置 | 问题与改造方向 |
|---|---|---|
| P1 / A | `frontend-cli/lib/components/tool-block.js`、`tool-display.js` | 完成工具反复 parse、split、wrap；缓存解析结果和最终行 |
| P1 / A | `frontend-cli/lib/text-width.js` | 普通 ASCII 也走 Segmenter/Array.from；增加安全快路径 |
| P2 / B | `frontend-cli/lib/cli-output-controller.js` | 300 ms 状态 tick 触发全局刷新；整合动画调度 |
| P2 / B | `frontend-cli/lib/components/tool-block.js` | 活动工具各自 1 秒 timer；改为可见活动的统一时钟 |
| P3 / B | `frontend-cli/lib/tui/component.js`、`tui/tui.js` | 全树平铺、ANSI 重置和 diff 随历史增长；保留稳定分段 |
| P3 / B | `frontend-cli/lib/components/assistant-message.js` | 不变 pending 仍可能重算，表格失效范围大；缩小失效范围 |
| P4 / B | `agent/runtime/core/stream_pump.py` | 无界队列、细碎事件；合并相邻文本并限界 |
| P4 / B | `frontend-cli/lib/frontend-cli-implementation.js` | Promise 消费链可能积压；增加可观察的消费边界 |
| P4 / B | `agent/runtime/server/stdio.py`、`tui/tui.js` | 同步 stdout flush / 未处理 write(false)；完善输出背压 |
| P5 / B | `agent/infrastructure/llm/cancellation.py` | 每 item 取消 task 分配；测量后复用流级等待 |
| P5 / C | `agent/domain/events.py` | asdict 递归复制候选；只在 profile 支持时替换 |
| P5 / C | `agent/infrastructure/persistence/jsonl_session_store.py` | 已有 projection 缓存，但 deepcopy/重读可能昂贵；先测命中和复制量 |
| P5 / C | `agent/runtime/server/execution.py`、`infrastructure/llm/trace.py` | 有界预览与可选逐 chunk trace；记录开关，不默认归因 |
| P6 / B | controller 的工具块索引与历史组件树 | 长会话保留完整展示对象；按需恢复与有界布局缓存 |

已有能力必须保留：text/dynamic/assistant 缓存、上下文 token_cache、任务事件驱动更新、128 项合并任务通知队列、TaskOutput 的有界队列/批次与 32 MiB 配额。达到输出配额后仍需排空子进程管道，不能让脚本阻塞。不要为已有能力再造同名抽象。

## 9. 分阶段实施设计

### P0：先建立可解释的基线

实现一个开发期回放入口，复用实际控制器、组件和协议。固定 fixture 驱动本地 fake provider；采集计数器和进程树资源。不在产品启动时常驻 profiler，不新增运行时依赖。

最小计数包括：请求帧/实际帧、组件 render 次数、工具 parse 次数、Markdown 输入字符数、ANSI/字宽处理字符数、终端写入次数/字节、排队字节/最老事件等待、事件循环延迟。计数在现有边界累加，按批次导出，禁止每 token 输出一条性能日志。

上述为待测指标清单，不要求把全部计数器永久加入产品。优先由外部 profiler、回放入口和现有可注入接口采集；确需内部观测时只传入当前测量使用的依赖，不建立全局 metrics 注册表，也不预留无人消费的字段。实验结束删除一次性埋点，保留的基准能力须有明确使用入口。

Node 用 CPU profile 与采样 heap profile；Python 用适用 Windows 的采样工具或局部 cProfile 诊断。带 profiler 的数据用于归因，无 profiler 的独立运行用于评分。收集 Node/Python 分别的 CPU、内存和启动阶段时间。

完成条件：固定 fixture 可重复得到相同的语义输出，能分别解释 UI、Runtime、工具和终端成本；生成原始结果与环境清单。当前局部实验只是 P0 的起点。

### P1：补齐工具缓存与 ASCII 快路径

**工具缓存边界：** ToolBlock 拥有自身展示状态及单宽度行缓存；tool-display 继续负责纯格式化，不获取组件内部字段或全局状态。优先通过现有 `invalidate()` 清缓存，不同时维护 dirty、revision、hash 三套重复状态。

`finish`、有效 `enrichArgs`、实际变化的 `setProgress`、`setExpanded` 和主题 replay 使相关缓存失效；无变化的 setter 不能触发重绘。宽度改变时只保留最新宽度结果，不按每个窗口宽度无限积累缓存。

结构化结果在接收完成事件时解析一次，通过明确参数交给 formatter。避免同时持有大段原始 JSON、完整解析副本、全量拆行副本和多份格式化行；原始持久化记录仍由已有会话层负责。只有消费者实际需要的表示才保留。

折叠输出优先提取需要展示的头尾与行数，避免每帧 split 全部 stdout。展开仍能取得完整结果，不能以截断原数据实现“省内存”。已完成工具 render 命中时不运行 JSON.parse、Intl.Segmenter 和重新 wrapping。

**字宽边界：** 对不含 ANSI、控制字符且所有字符位于 U+0020–U+007E 的字符串直接返回长度。其他输入走现有 Unicode/ANSI 算法；不能将 emoji、组合字符、制表符或东亚宽字符当成长度 1。先只有快路径，剩余成本不足时不增加缓存；需要缓存时按实例、按容量限制。

完成条件：100/400 个已完成工具在相同宽度连续刷新时 parse/wrap 计数不增长；当前组件 fixture 在本机热缓存下 400 块 render 中位数目标 ≤5 ms，输入和主题/展开/resize 结果与原实现一致。工具缓存与字宽快路径分两个提交，分别比较收益。

### P2：统一按需调度与可见动画

保留一个 TUI 帧请求入口，输入、内容与动画只是不同优先级的请求原因，不各自直接写终端。键盘输入在下一可用事件循环优先刷新；普通流式内容先以约 33 ms 合并作为起始预算；终止状态及时刷新。先用常量与已有依赖，不增加复杂用户配置面板。

将 controller 状态 tick 和每个工具的 timer 归到同一个控制器拥有的时钟。只安排下一个真正可见的变化：秒数按秒变化，呼吸按亮度档位变化；无活动动画或可见输出未变时不申请帧。输入不能受动画降频影响。

这里的“统一时钟”优先通过现有 controller 内的函数和一个可取消定时器实现，不新建调度服务、时钟类或任务注册框架。“输入优先”优先复用现有即时刷新契约，不为少量请求原因引入通用优先队列。计时与调度依赖从拥有者显式传入；同一帧使用一致的时间值，避免组件自行读取时钟造成隐藏差异。

Waiting 保持已经确定的语义：仅模型空闲且 authoritative `background_wait` 存在时显示；保留 4.2 秒呼吸周期、dim 分隔符、dim 任务数量、自动继续说明，不改为旋转图标，不凭 CLI 猜测任务状态。可以用约 6–10 次/秒的亮度步进验证观感；这是试验参数，不能为了省电牺牲现有平静呼吸体验。`NO_COLOR` 下文字静止，只在秒数变化时更新。

只有 P3 提供可靠可见范围后，才跳过离屏工具动画；P2 先做到单一时钟和没有变化就不画，避免为了“可见性”新增第二套布局计算。时钟在切换会话、退出 tour、销毁控制器时取消；旧回调不得复活已退出界面。

完成条件：空闲没有周期帧；同一时刻只有一个动画调度源；Working、Waiting、工具运行的视觉与焦点行为通过虚拟终端断言。重复 `/tour → Enter → Esc → /tour → Enter` 可正常输入与退出，Ctrl+C 有效。

### P3：稳定历史分段与变化区域计算

分两步实施，避免一次重写 TUI。

**P3a：复用行与布局。** 现有 `render(width) -> string[]` 保留。叶子缓存不可被调用方修改；ANSI 行尾 reset 与字宽防御性处理只在该叶子结果改变时执行。为 transcript 内部增加稳定块记录和行偏移，不在每次 tick 重新构造整段历史数组。历史结构增删、主题与宽度变化由显式调用失效。

先验证现有显式失效通知能否支持父层复用；只有存在具体调用方且现有契约不足时，才统一增加 render revision 契约，所有同类组件共用，并删除被替代的重复 dirty 状态。revision 仅描述可观察输出版本，不用深度哈希、不读取子类私有字段，也不暴露业务状态给引擎。禁止同时维护语义相同的 dirty、revision、signature 或多套“是否需要刷新”标志。

**P3b：保留稳定前缀，只重算活动尾部与底部区域。** transcript 提供稳定分段、行数与变化范围；TUI 负责坐标、cursor、diff 和一次写入。controller 负责业务状态和失效通知，不直接操作终端坐标。业务层不依赖渲染器的内部 previousLines。

普通状态帧的目标复杂度为 O(变化块 + 可见行)，追加内容的工作量主要随新增内容增长。resize、主题切换、全局展开等全局变化允许 O(历史量)，必须单列计时并保持输入响应；不能宣称所有帧永久 O(1)。

现有原生 scrollback、resize 重排、ctrl+o 展开与离屏变化 full replay 都有可观察语义。先保留这些路径，将整段 replay 限定在真正必要的操作。若以后改为 owned viewport，应作为单独设计决定，明确选择、复制、搜索与滚轮行为，不能作为本轮优化的隐式副作用。

AssistantMessage 优先给不变 pending 建缓存，并仅失效受影响表格或尾部。长期无换行文本采用块化源数据或受控重排，防止每 token 重扫累积全文。安全边界不明确时回退现有完整解析，以同一渲染器的完成态结果作为 oracle。

完成条件：400 与 4,000 个完成块的状态帧耗时不再近似十倍增长；全量回放与增量结果的屏幕、scrollback 和光标一致；新增状态只保存实际需要的布局信息。

### P4：无损事件合并、有界队列与输出背压

首先在 `stream_pump` 选择**唯一的语义事件合并边界**，以约 25 ms 或 8 KiB 先到者 flush 作为起始实验参数。前端帧合并独立处理展示，不再增加另一段 25 ms 的协议 debounce。所有等待时间计入端到端显示延迟。

只拼接相同 session、request、message、channel 的连续文本 delta；reasoning 与正文不混合。工具参数只有在契约允许字节拼接且 tool_call_id 一致时才合并。不能跨越工具开始/结束、错误、取消、消息完成、turn 完成、背景任务交接和会话切换。

这些边界先结清前序文本，再传递控制事件。批次内部仍复用现有事件类型，优先避免新增客户端协议；仅当现有协议确实无法表示必要行为时才增加显式版本化能力。

合并器只处理既有标准事件，不读取具体 provider 的内部对象，也不为每个 provider 增加独立开关或旁路。需要的会话/消息/工具标识取自已有事件或显式流上下文，不为每一层复制同一组标识。优先用函数和局部流状态实现；已有背压接口能满足要求时不再包装第二层队列。

队列同时限制事件数与字节，例如以 256 项、1 MiB 作为初始预算并测量高水位。单个大消息须有独立的合法大小和传输策略，不能通过“允许一个无限大的元素”绕过预算。可替代状态快照允许同 key 覆盖；文本、工具参数和控制事件必须无损。

队列关闭和取消不得依赖往已满队列塞 sentinel：使用明确的 close/cancel 状态唤醒生产者与消费者，终止后回收所有等待任务。取消控制能中断被背压挂起的生产者；事件顺序仍由单一发送路径保证，不能靠无序双通道超车。

`stdio.py` 的阻塞写入应先测量。若确实阻塞事件循环，使用一个拥有有限队列的输出 writer，把可能阻塞的 write/flush 与取消处理隔离；不为每次 write 启动线程。退出时处理 drain、断管与超时，普通完成不得静默丢尾部。共享协议消费者都要通过回归，不把优化偷偷限制为 CLI。

Node 侧处理 `output.write()` 返回 false 与 `drain`。终端拥塞期间保留最新**可重建的屏幕状态**，停止生成无用中间帧；原生历史追加和完整非 TTY 文本不可随意覆盖。把“待写屏幕帧”和“不可丢弃内容”分清，仍只保留一个终端写入者。

完成条件：慢终端、突发 provider、取消与退出同时发生时不死锁、不乱序、不跨 session，内存队列有界。`rind run` stdout 的最终答案完整且只出现一次，诊断不混入 stdout。

### P5：根据 profile 降低 Python 开销

先分别测量等待首 token、流式消费、工具执行、上下文准备、会话恢复与完成持久化，再按热点实施。

- 对流迭代复用一次 cancellation wait；每次 anext 仍可被取消。读取与取消同一轮就绪时的优先级必须明确，finally 关闭流并回收 task；禁止遗留取消监听器。
- 仅在序列化占比明显时，将热事件的递归 asdict 换为显式字段映射；字段规范仍来自既有事件契约，不维护第二套冲突 schema。
- 保留当前文本/reasoning list-join 方案。工具 arguments 的字符串追加仅在实测输入规模下成为热点时再改。
- 对会话 projection 统计缓存命中、读取字节和 deepcopy 时间。若取消复制，先明确只读所有权接口，不能直接返回内部可变对象让上层修改。
- trace 默认关闭。开启时单列负载，不扫描或记录密钥；若优化 trace 批写，明确错误与退出 flush，不降低正常会话记录的完整性。

完成条件：每项都有优化前后相同 fixture 的 profile 证据；停滞网络下取消仍及时。未进入热点的模块不为了“可能更快”重构。

### P6：长会话内存预算与按需历史

先区分原始会话数据、展示对象、渲染行、暂存输出和临时分配，测出哪部分随会话线性增长。渲染缓存只保留当前宽度和必要邻近块；预算覆盖字节和条目，清理规则属于会话/渲染器实例，退出释放全部引用。

完整输出保存在现有会话与任务存储中，CLI 常驻最近活动内容和可恢复引用。用户查看旧历史或 ctrl+o 展开时按需加载，错误时明确提示，不能静默展示不完整数据。实现前验证现有存储是否支持所需定位；若必须加索引，只增加一个可从原始日志重建的索引，不引入另一套持久化源。

当前 toolBlocks map 服务于展开操作，不能简单删除旧项。先提供按稳定 ID 恢复的路径，再让索引只保留最小元数据。native scrollback 与持久化历史不是同一份内存；终端进程的 scrollback 消耗另行测量。

内存预算不能靠每隔几秒强制 GC 实现。以分配率、GC 暂停、稳定状态内存和长跑斜率共同验收。只有应用自己的缓存有界并不代表总内存一定有界，Python/Node 堆、SDK、终端与大任务也要分别解释。

长跑验收分两种：固定大小历史反复进入/退出用于查泄漏，持续追加新历史用于查保留策略。前者预热 10 min 后再测 50 min，候选门槛为 Private Bytes 趋势 ≤0.5 MiB/min，停止活动并等待自然回收后较预热稳态增量 ≤20 MiB；不能用该门槛要求“合法新增内容完全不占内存”。后者报告每千条记录增量、缓存高水位和历史存储增长，P6 完成后展示缓存应在预算附近形成平台，原始持久化数据可随内容增长。两类都记录自然 GC 波动，不用单个首尾样本判断泄漏。

### P7：持续评测与发布门槛

每个阶段先跑相关确定性回归和组件基准，稳定后跑公共场景全套。CI 默认执行本地 fake-provider 和虚拟终端测试，不调用真实模型；真实终端及真实 provider 验收按仓库测试政策另行执行。

不要等 P6 才验证收益。P1 后就应重新测量 turn CPU；若主要问题已解决，后续只实施仍有证据支持的部分。每阶段保留独立提交和前后结果，方便回滚。

## 10. 接口与依赖规则

下图表示运行时数据流，不表示模块 import 方向；事件或回调向上交付结果不构成反向依赖，前提是下层不导入、定位或修改上层具体实现。

```text
Provider SDK → 取消感知的流消费 → Runtime 事件合并/生命周期 → 协议输出
                                                               ↓
终端写入 ← TUI 帧调度/布局/diff ← 组件显式渲染契约 ← CLI controller

会话存储 → 显式只读历史接口 → controller
测量器在边界观察，不成为生产执行所依赖的业务层。
```

Python 不接触终端主题、光标或动画，CLI 不判断任务是否应自动续接；会话/task 状态仍来自 Runtime。渲染器只接收展示输入，不反向访问业务对象。组件不能直接 stdout.write；controller 不碰引擎私有布局缓存。

组装入口显式连接已有 Runtime、controller、组件和 TUI。下层只接收完成当前职责所需的数据、函数或已有接口，不传入整个应用对象充当隐式服务容器。导入模块不得悄悄启动 timer、注册监听器、写终端或创建 Worker；开始、取消和释放均有明确调用方与所有者。

同类组件统一使用渲染/失效契约；同类事件处理器统一使用事件与生命周期契约；provider 差异收敛在既有适配边界，不泄漏到 renderer。遇到双向依赖先识别真正共用的部分，仅下沉这部分，不能用动态导入、全局单例或读取对方私有字段掩盖环。

优先扩展已有函数与接口。不要为每个工具新增一种缓存协议、每个 provider 新增一种批处理规则，也不要为了性能另建全局事件总线、通用调度框架或“缓存管理服务”。当最简单的一项缓存已能消除热点时，停止增加抽象。

### 10.1 新增状态与资源的边界

| 内容 | 唯一拥有者与规则 | 禁止的重复或耦合 |
|---|---|---|
| 任务、请求及自动续接状态 | Runtime 的既有生命周期接口 | CLI 再存一套可独立变化的业务真值 |
| 组件行缓存 | 对应组件；按显式内容/宽度/主题失效 | 为同一条件重复存储多组标志，调用方修改缓存数组 |
| 历史布局与坐标 | transcript/TUI 各自接口限定的职责 | controller 跨层改行偏移，组件另算全局布局 |
| 动画计时器与订阅 | 现有控制器统一创建和释放 | 全局注册表、组件私建重复 timer、销毁后残留回调 |
| 流式暂存与 writer 队列 | 对应流或输出实例；按显式容量及关闭契约管理 | 模块全局队列、无界 Promise 链、无人消费的缓冲副本 |
| 性能观测 | 开发期测量入口或显式注入的观察者 | 业务依赖测量器，未启用测试仍创建采样资源 |

表中是所有权要求，不是新增类或字段清单。持久化记录、运行状态、布局缓存可以因职责不同而共存，但不能变成互相同步的多份权威状态；每份派生数据都必须能解释必要性及何时丢弃。

## 11. 可复现横向评测设计

### 11.1 三层测试，分别回答不同问题

**公共计分强制使用完整交互式 CLI 的真实 UI 渲染路径，且仅采用下表 L3 结果。** 四个产品都必须在 PTY/ConPTY 与同一终端模拟器中启动正常交互入口，实际执行组件布局、文本格式化、动画、diff 和终端绘制。不能使用 one-shot、exec/print 模式、`rind run`、重定向后的非 TTY 模式、纯 Runtime/API 调用或 NullTerminal 代替。即使一次测试只发送一个请求，也必须从交互输入框提交，并在响应结束后保留交互界面。

| 层级 | 测试对象 | 能回答 | 不能回答 |
|---|---|---|---|
| L1 组件/NullTerminal | 真实渲染函数、固定内容、无终端解析 | 布局/格式化/分配热点 | 真实输入观感、终端 CPU、产品总负载 |
| L2 完整应用 + 本地 fake provider | 发布构建、真实协议与进程树，自动化回归可使用虚拟终端 | 协议/队列/取消正确性、资源归因与预评测 | 真实终端绘制成本，不能用于公共计分 |
| L3 真 PTY/ConPTY + 同一终端 | 正常交互式 CLI、完整 UI、真实输入和终端绘制，provider 可为本地回放 | 公共计分、可见延迟、闪烁、输入/resize、终端成本 | 无能耗仪时的准确瓦数 |

三层都需要，但 L1/L2 只用于定位与回归，不能与 L3 混算或替代缺失的 L3 成绩。终端必须实际消费输出并完成绘制，不能只分配一个伪终端后丢弃字节。测试窗口保持相同的可见/前台状态，不以最小化或隐藏某个产品规避终端绘制成本。性能 profiler 运行与正式计分运行分开，保存采样开销的说明。

本地 fake provider 仅替换模型服务，按真实协议与固定时间表返回内容；Runtime、CLI 事件消费、组件和终端渲染全部正常运行。不得直接把最终文本塞进 UI 或预先生成屏幕帧来绕过这些环节。这样既消除模型输出差异，又测到用户实际使用时的 UI 开销。

每轮计分前确认并记录：启动命令为交互入口、应用检测到 TTY、终端尺寸正确、输入框可用、Working/工具/流式内容按该产品正常方式显示。保留终端输出记录和关键屏幕状态证据；C02/C03 等静止场景验证界面存在且可响应输入，不要求它们产生无意义重绘。缺少交互 UI 或退化为非 TTY 的样本标为无效，不能用低资源值计分。

### 11.2 工作负载公平性

建立一份与产品无关的逻辑 fixture：相同正文、代码、表格、工具输出字节、发布时间表、任务退出码。各产品适配其支持的 OpenAI Responses、Chat Completions 或其他本地协议；适配仅改变线格式，不减少内容或改变发布时间。fixture 及适配后数据都保存 SHA-256。

不通过真实模型生成不同答案来比较渲染效率。provider 在独立进程运行，CPU/内存单独记录，不计入 agent；如果背压使服务器无法按计划发送，同时记录计划时间和实际时间，不能用吞吐下降制造低 CPU。

公共场景用所有产品能完成的同一类交互；Rind 原生 `on_exit`、多 session Worker 等单独成组。如果竞品没有对应能力，标 N/A，不记为零成本，不进入公共总分。工具 schema、系统提示长度和历史存储格式可能不同，应记录差异并分别报告冷启动/恢复成本。

产品默认正常体验作为主表；显式“性能配置”作为第二张表，所有差异公开。不得只关闭 Rind 动画或工具显示，却保留竞品默认特效。扩展、MCP、hooks、联网检查、trace、遥测和后台服务均记录，测试 home 隔离，不读取用户私有会话。

使用固定 SHA 的 release/生产构建：Codex/Crush 优化构建，Pi/Rind 对应发布产物与锁定运行时。源码开发模式另测，不能拿 Node watch/debug 模式与 Rust release 比较。分别报告是否需要常驻或共享 Worker，不为 Rind 省略其 Runtime 成本。

### 11.3 系统与采样

固定终端版本、字体、颜色能力、scrollback 容量、窗口 100×30；兼容性另测 80×24、160×50。Windows 为首要目标；Linux/macOS 分别形成独立表，不跨 OS 混合内存口径。

使用单调时钟；CPU 以进程 user+kernel 差值累计，内存约每 100–250 ms 采样，避免高频监测本身成为主要负载。进程树使用 ETW/系统退出事件或等效机制覆盖短命子进程；简单每秒扫描 PID 会漏计。Windows 可在兼容前提下使用 Job Object 辅助归属，不能为了测量改变实际子进程退出行为。

每轮顺序随机化，至少 5 次独立重复；启动延迟等分位数至少 30 次样本。区分冷文件缓存/冷进程与热启动，记录电源模式、电池/接电、CPU 频率、温度与并行负载。先预热，再进入固定计分窗口；样本不足时不要给出可靠 p99 的假象。

统计报告中位数、p95/p99、试验间离散程度及 bootstrap 置信区间。事先固定异常排除规则，仅因系统更新、测试失败等可证明的外因排除，保留原因；不能删掉“看起来很慢”的样本。

### 11.4 资源归属

| 对象 | 记录方式 | 排名处理 |
|---|---|---|
| Agent 自身 | CLI + Runtime + 必需 Worker 的全部 CPU/内存 | 主计分 |
| 被调用工具 | shell、搜索、回测等后代单列 | 全链路附表；不能把回测计算算作 UI 浪费 |
| 终端模拟器 | 同设置空白终端对照 + 运行终端，记录增量及噪声 | 单独门槛与体验证据，不静默转移成本 |
| fake provider | 独立 PID 与发送时间表 | 不计入 agent，检查其是否成为瓶颈 |
| 采样/回放程序 | 独立 PID、版本和采样频率 | 不计入 agent，估计测量开销 |

主计分内存：Windows 使用进程树 Private Bytes，另报 working set；直接相加 working set 可能重复计算共享页。Linux 优先树 PSS，另报 RSS/USS；macOS 使用系统可取得且一致的 physical footprint 等口径。Shared Worker 做单 session 独占基准以及 1/4/8 session 的总量/边际成本，不把共享进程完整计入每个 session 后再相加。

### 11.5 用户真正感知的延迟

输入延迟从注入按键到目标字符或光标在终端可见，不仅测输入 handler 返回。流式显示延迟从 provider 实际发布内容到屏幕可见；完成延迟还需确认尾部和状态已显示。用 PTY 输出解析建立可重复代理，L3 对代表性场景通过屏幕帧验证代理误差。

空闲资源窗口不注入按键；紧邻窗口用相同会话状态测响应，避免测试操作污染“空闲 CPU”。在多个独立重复中收集足够事件算分位数。对没有足够样本的场景延迟报告最大值与样本量，不强行估计 p99。

活跃窗口的输入脚本固定为每秒输入 2 个字符，分组退格恢复，不提交新的请求；所有产品用同一序列和时刻。另设 200 次短突发输入/粘贴探针，记录粘贴长度与组合字符。空闲相邻响应窗口也使用这套脚本但单独计时。需要 p99 门槛的输入分布至少累计 1,000 个有效可见样本，并报告样本间相关性；冷启动仅 30 次时主要报告中位数、p95 与最大值。

取消分为 UI 确认、Runtime 停止消费、工具进程结束三个时点。只显示“已中断”但模型/子进程仍运行不能通过取消验收。

### 11.6 功耗与低负载不能混为一谈

CPU 时间、上下文切换、唤醒频率和内存是负载代理，不是瓦数。能获取 RAPL、整机功率计或可靠平台能耗计数时，在相同电源/温度条件下测固定工作负载的焦耳及空闲平均瓦数，扣除同终端空白对照并报告误差。

CPU package 能耗也不是精确进程能耗；Windows 上没有可靠传感器时写“能耗未测”，不由 CPU% 换算电池续航。低负载评分和实际能耗结果分开发布。

## 12. 场景矩阵

### 12.1 公共计分场景（权重合计 100）

以下持续时间为有效采样段，准备历史与恢复时间另计。文本发布速率以 UTF-8 字节及事件频率定义，不用各模型不同的 token 数替代。

**C01–C10 全部遵循第 11.1 节的 L3 交互 UI 要求。** 启动/空闲场景保留真实输入界面；等待/流式/工具场景通过输入框触发真实 turn，并保留状态栏、历史工具块及正常动画；滚动/展开/resize 通过实际终端交互触发。后台回放程序只负责驱动输入与本地 provider，不能把公共场景改成无界面的 one-shot。非 TTY 与 `rind run` 的验证仅属于独立兼容性测试。

| ID / 权重 | 场景与固定输入 | 主要检查 |
|---|---|---|
| C01 / 8 | 启动至首个可输入画面；30 次热启动，冷启动另表 | CPU 总时间、启动峰值内存、首帧延迟、输出字节 |
| C02 / 8 | 新会话无 turn 空闲 120 s | 空闲 CPU、无故定时器、驻留内存、邻接输入探针 |
| C03 / 8 | 加载 400 个完成块后空闲 120 s；工具/文本各半 | 历史规模对静态负载与内存的影响 |
| C04 / 8 | 请求发出后 provider 保持连接、不发内容 60 s，随后结束 | Working 动画成本、等待时输入、取消；不是 on_exit |
| C05 / 16 | 60 s，20 delta/s，平均 64 B/delta，普通 Markdown | CPU、显示延迟、输入延迟、终端写放大 |
| C06 / 12 | 60 s，每 2 s 突发 100 个 64 B delta，余时静默 | 积压、追赶时间、事件无损、内存高水位 |
| C07 / 12 | 90 s，混合 CJK/emoji/ANSI、长段落、围栏代码、宽表格，总源 256 KiB | Unicode 正确性、可变尾部复杂度与 resize 后一致性 |
| C08 / 12 | 400 个完成工具，每个 60 行输出，折叠后再流式 60 s | 已完成工具重复工作、历史规模对活跃帧的放大 |
| C09 / 8 | 同一脚本以 64 KiB/s 输出 60 s，最终退出；公共接口执行 | 排空、展示限额、agent/tool 成本分离、最终输出完整性 |
| C10 / 8 | 200 条相同会话记录，输入/滚动/展开/resize 固定脚本 60 s | 实际响应、行布局、终端成本与输入保留 |

若某产品不支持 C10 中某项交互，先定义四者公共操作集，非公共操作移到原生能力测试；没有经过统一调整的结果不得给出四方总排名。固定场景与权重后再跑，不能为有利于 Rind 临时删场景。

### 12.2 非计分压力与原生能力场景

| ID | 内容 | 通过要求 |
|---|---|---|
| X01 | Rind 静默 on_exit 后台 10 min，含多个任务 | Waiting 呼吸/秒数正确、低负载、完成后自动继续、不重复续接 |
| X02 | CPU 密集回测 5 min，工具输出稀疏 | agent 自身成本低，工具 CPU 单列；不限制工具算力伪装节能 |
| X03 | 连续 1 MiB 无换行正文、巨大单行工具输出 | 不二次方退化失控；完整文本可取回，按键可用 |
| X04 | 终端输出限制为 4 KiB/s，provider 突发 1 MiB | 排队有界、取消/退出无死锁、非 TTY 不丢文本 |
| X05 | yield 前后 Ctrl+C，退出与保留会话，工具终止竞态 | 状态、清理与续接抑制符合既有契约 |
| X06 | 1/4/8 session，共享及独立 Worker，混合 on_exit/on_manual | task 查看与通知严格隔离；总量与边际开销可解释 |
| X07 | 60 min、1,000 次短 turn/工具组合，反复切会话 | 无持续泄漏；task/timer/listener/queue 数回到稳定基线 |
| X08 | `/tour` Esc 退出再进入 100 次，夹杂 turn、resize | 键盘与 Ctrl+C 始终可用，无额外监听器残留 |
| X09 | 80×24 / 160×50、NO_COLOR、重定向 stdout、TTY 断连 | 内容与焦点正确，断管清理，无 ANSI 污染管道 |
| X10 | 主题切换、全局展开、恢复旧历史与损坏记录 | 缓存正确失效，失败可解释，不吞输出 |

X 场景可以阻止 Rind 发布，但不把竞品不支持的能力转成竞品性能扣分。

## 13. 评价与打分体系

### 13.1 先过功能与体验门槛

任何一项出现丢失文本、错误模型/任务归属、错误退出码、取消失效、键盘卡死、未界定的队列持续增长或历史不可访问，标为**不合格**。不合格结果仍公开资源原始值，但不能进入“最优”排名。

在上述功能门槛之前，先检查评测模式资格：必须有 L3 完整交互 UI 的有效证据。one-shot、无 UI 或仅虚拟终端的结果不属于公共评测样本，不能获得分数或补齐场景覆盖率。

建议预注册的公共体验门槛：输入可见 p95 ≤50 ms、p99 ≤100 ms；常规流式可见 p95 ≤100 ms；provider 结束至尾部完全显示 ≤150 ms（正常终端，不含真实工具尚未结束）；UI 取消确认 p95 ≤150 ms。慢终端 X04 的尾部延迟受带宽约束，单独按理论排空时间验收，不强套 150 ms。

这些是初始设计目标，不是当前实测结果。P0 可以根据仪器与平台能力修订一次，并记录理由；必须在优化成绩揭晓前冻结，不允许事后放宽以宣布成功。取消工具的优雅退出等待与强制回收另按现有任务契约测试。

### 13.2 每场景的四个维度

| 维度 | 权重 | 原始指标 |
|---|---:|---|
| CPU | 40% | C01 为 agent 树 CPU 毫秒；其他为固定窗口单核 CPU%（同时报告 CPU 秒） |
| 内存 | 30% | agent 树 Private Bytes/PSS，60% 用 p95、40% 用峰值；OS 分表 |
| 终端输出 | 10% | C01 写出总字节；其他为固定窗口字节/秒；另报调用数与终端 CPU |
| 响应 | 20% | C01 为首个可输入画面延迟；其他用输入可见 p95，有流时与流显示 p95 各占一半 |

分配量、GC 暂停、上下文切换、队列年龄和真实能耗为必报诊断或独立附表，不强行用跨平台不一致的“唤醒次数”混进总分。数据缺失不能以 0 代替，也不通过重新归一化提高得分。

### 13.3 固定预算归一化

对越小越好的指标 x，定义优秀预算 G 和低分端点 B（B > G）：

```text
score(x; G, B) = 100                         当 x ≤ G
                100 × (B - x) / (B - G)      当 G < x < B
                0                           当 x ≥ B

场景分 = 0.40 S_cpu + 0.30 S_memory + 0.10 S_output + 0.20 S_response
总分 = Σ(场景权重 × 场景分) / 100
```

B 只是该指标的零分点，不等同于功能门槛；一个产品可以功能通过但负载得分低。超过优秀预算以后仍展示原始值与相对比值，避免 100 分掩盖进一步差异。

以下是 Windows 首轮**候选** G/B；P0 冻结后用于四者同一张表，不按产品分别设置。

| 场景 | CPU G / B | 内存 p95 G / B（MiB） | 输出 G / B | 响应 G / B（ms） |
|---|---|---|---|---|
| C01 | 300 / 3,000 CPU ms | 250 / 750 | 32 / 256 KiB 总量 | 400 / 2,000 首帧 |
| C02 | 0.2 / 2 单核% | 250 / 750 | 0 / 16 KiB/s | 20 / 100 输入 |
| C03 | 0.3 / 3 单核% | 350 / 1,000 | 0 / 16 KiB/s | 20 / 100 输入 |
| C04 | 1 / 10 单核% | 250 / 750 | 2 / 32 KiB/s | 20 / 100 输入 |
| C05 | 5 / 30 单核% | 300 / 900 | 16 / 128 KiB/s | 20 / 100 输入；50 / 150 显示 |
| C06 | 6 / 40 单核% | 350 / 1,000 | 24 / 192 KiB/s | 20 / 100 输入；50 / 150 显示 |
| C07 | 8 / 50 单核% | 400 / 1,200 | 32 / 256 KiB/s | 20 / 100 输入；50 / 150 显示 |
| C08 | 8 / 50 单核% | 400 / 1,200 | 16 / 128 KiB/s | 20 / 100 输入；50 / 150 显示 |
| C09 | 8 / 50 单核% | 400 / 1,200 | 64 / 512 KiB/s | 20 / 100 输入；50 / 150 显示 |
| C10 | 10 / 60 单核% | 400 / 1,200 | 64 / 512 KiB/s | 20 / 100 输入 |

内存峰值 G/B 为同场景 p95 预算的 1.25 倍；响应两项先各算分再平均。C09 显示延迟只针对公共 fixture 约定应当可见的进度/尾行，不要求所有高吞吐工具字节都立即显示；完整输出另做无损校验。颜色模式和样式有差异，因此输出预算是辅助指标，不能以删除样式换分。

### 13.4 “最优”的判定

第一层为绝对达标：功能/体验通过，Rind 总分目标 ≥90；无动画空闲接近零开销，普通流式目标 ≤5% 单核，静默 on_exit 等待目标 ≤1% 单核。Python+Node 常驻空会话内存目标先定 ≤250 MiB，能否达到由正式基线验证；原始字节、运行时基础开销和功能差异必须解释。

第二层为同场景比较：报告 Rind 与每个竞品的 CPU 时间比、内存比和延迟比，以及各自 95% 置信区间。对非零且可稳定测量的 CPU 时间取场景加权几何平均：

```text
R_cpu = exp(Σ weight_s × ln(CPU_rind,s / CPU_reference,s) / Σ weight_s)
```

reference 必须是同一个固定产品；分别与三个产品计算，不能每场景挑一个不同对手后称作“某竞品”。零附近的空闲 CPU 不作比值，单列绝对差，且公开排除权重；相对分析不能替代全覆盖绝对评分。

进取目标为相对每个可比产品的 R_cpu ≤0.90，且内存与交互延迟不产生超过 10% 的明确回退；低于测量分辨率或置信区间重叠时标记“未分出差异”。某产品在内存上明显更优时应如实报告，不以综合分遮盖。

若总分领先但仍明显牺牲终端 CPU、内存或延迟，不宣布全面最优。终端成本与代理自身成本都下降、或形成明确可接受的 Pareto 取舍，才是可靠结论。长期目标可以进取，发布结论必须受证据约束。

### 13.5 当前结果表

| 产品 | 源码调研 | L1 局部实验 | L3 交互 UI 公共场景 | 综合分 / 排名 | 实际能耗 |
|---|---|---|---|---|---|
| Rind | 已完成 | 工具渲染/取消机制已测，见第 7 节 | 待实施 | 未评分 | 未测 |
| Codex | 已完成 | 未测 | 待实施 | 未评分 | 未测 |
| Pi | 已完成 | 未测 | 待实施 | 未评分 | 未测 |
| Crush | 已完成 | 未测 | 待实施 | 未评分 | 未测 |

本次没有完成四产品运行负载排名。当前能支持的是具体机制判断与 Rind 局部热点，正式横向结果属于本方案实施阶段的交付。

正式报告按每个 OS 展开 10 个公共场景，每格填写“中位数 [95% CI] / p95 / n”，至少并列 Rind 改前、Rind 改后、Codex、Pi、Crush 五列；CPU、内存、可见延迟、终端成本分别成表。合计 100% 公共场景且四个评分维度都有有效数据后才计算正式总分；未覆盖时只列已测项目与覆盖率。显示 CPU/内存 Pareto 散点和长跑时间曲线，避免单一总分掩盖某场景退化。

## 14. 正确性、性能与体验回归矩阵

| 修改 | 必须验证的边界 | 不接受的捷径 |
|---|---|---|
| 工具缓存 | 完成/失败/取消、迟到参数、主题、宽度、展开、文件变更 | 缓存永久不失效，旧颜色/旧结果留屏 |
| 字宽快路径 | CJK、ZWJ emoji、组合音标、变体选择符、ANSI、tab、控制字符 | 用字符串 length 处理所有 Unicode |
| 增量 Markdown | 无换行、围栏、表格增行、列表/引用、Setext、引用链接 | 把会改变语义的尾部提前永久冻结 |
| 历史分段 | 追加/删除/收缩、离屏变化、主题重放、resize、光标 | 清掉原生历史却不说明行为变化 |
| 动画调度 | turn/等待切换、多任务、NO_COLOR、tour 退出、销毁 | 降低按键响应、隐藏运行状态 |
| 流事件合并 | reasoning/text/tool 参数隔离、交错 tool ID、错误/完成 | 丢 token、跨 session 合并、重复完成 |
| 有界队列 | 消费者慢/消失、满队列取消、断管、关闭竞态 | 用无限 pending Promise 代替无限 Queue |
| Python 取消 | 读取/取消同时完成、SDK 抛错、网络不返回、关闭抛错 | 只有收到下个 token 才能取消 |
| 历史内存 | ctrl+o、恢复、旧任务输出、异常记录、切会话 | 删除用户历史或靠强制 GC 达标 |
| 任务生命周期 | on_exit/on_manual、yield 前后中断、退出、共享 Worker | 为省轮询破坏续接或隔离 |

使用已有虚拟终端测试验证屏幕与硬件光标，补充针对新增失效/背压边界的确定性用例。性能测试断言有意义的行为，例如“状态帧不会重新 parse 完成工具”，不要将某个实现内部字段值写成脆弱测试。

### 14.1 每阶段的实现验收

每个阶段除功能、体验与负载验证外，还必须通过以下代码评审条件；任何一项未通过都不能因性能分数提高而标记完成。

| 检查项 | 通过标准 |
|---|---|
| 必要性 | 每个新增字段、函数、接口、分支和配置都有当前用途；无预留实现、未使用实体或重复权威状态 |
| 最小实现 | 复用现有边界；新增抽象有具体需求证明；函数能解决的职责不包装成新类或框架 |
| 命名与同构 | 名称清楚表达含义、单位和作用域；同类调用方共用一套契约，无歧义别名与专用旁路 |
| 单向依赖 | 修改范围内不存在双向模块依赖；必要公共逻辑下沉；无跨模块私有状态访问 |
| 显式生命周期 | 依赖显式传入，资源启动/释放可追踪；无新全局可变状态、隐藏执行顺序或导入副作用 |
| 清理与收益 | 旧实现及残留已清理；相关歧义/低效片段已修复；功能和真实交互 UI 体验不退化，收益有对应证据 |

通过现有静态检查、调用点检索、相关回归和聚焦 diff 审查完成核对，不为这张检查表额外引入架构扫描框架。简洁性不等于压缩成难读代码，也不以代码行数减少替代边界正确性。

## 15. 交付、Git 与实施顺序

建议依次提交：基准与计数 → 完成工具缓存 → 字宽快路径 → 调度整合 → 历史分段 → 事件合并/背压 → 有 profile 支持的 Python 调整 → 有界历史 → 全量评测报告。每个提交只解决一个可评审问题，不混入 provider、发布或主题重设计。

P1 依赖 P0；P2 可以在 P1 后独立验收；P3 建立在缓存正确性上；P4 依赖协议 fixture 和取消测试，不必等待所有视口工作；P5 必须有 profile；P6 依赖明确的历史所有权和访问接口。阶段结束重新判断下一步收益，删除被替代的 timer、缓存字段和旧分支。

替换与清理原则上在同一提交完成：移除旧调用点、废弃参数、重复状态、无用导入、过时测试与注释，并同步实际改变的接口文档。若保留兼容分支，提交说明必须指出当前受支持的调用方及覆盖它的测试；没有实际使用者的兼容层不保留。性能试验未产生收益时撤掉试验代码；回滚依靠独立 Git 提交，不在生产代码中长期保留两套实现和切换开关。清理聚焦本次修改路径，不夹带无关大范围重构。

后续拟新增的基准目录应优先复用现有 `frontend-cli/test` 与 Python `test` 结构，只放开发工具和无隐私 fixture。大 profile、原始长日志与二进制结果放独立结果目录，记录摘要/hash，不作为 npm 运行依赖或默认启动内容。当前文档不创建这些文件。

每次正式结果至少包含：

```text
manifest: 产品 SHA、构建命令/版本、锁文件 hash、OS/CPU/内存、终端、
          电源模式、环境开关、fixture hash、协议适配版本、场景顺序、
          交互启动命令、TTY 状态、窗口前台/可见状态、UI 验证记录
samples:  trial、scenario、单调时钟、PID/role、CPU user/kernel、
          private/PSS/working-set、输出字节、队列字节、可见延迟
summary:  中位数/分位数/置信区间、功能门槛、各维度分、覆盖率、失败原因
profiles: 独立剖析运行的采样文件与符号/源码版本
```

当前 `.docs` 被 Git 忽略。若提交方案，只精确 `git add -f .docs/rind-low-load-optimization-plan-zh.md`，不修改忽略规则，不把整个 `.docs` 强制加入。实现时先检查工作树，隔离用户已有修改；不自动发布、不改版本号。

## 附录 A：局部实验的复现入口

以下为等价复现示例，用于解释第 7 节方法，不是完整跨产品基准。结果可能因系统负载和计时粒度不同而变化。均从仓库根目录执行，脚本可直接通过 stdin 传入，不需要保存文件。

### A.1 Node 完成块渲染

通过 `node --input-type=module` 运行下面 JavaScript，并在进程环境设置 `NO_COLOR=1`。每个组合单独运行更有利于减少相互影响。

```javascript
import { performance } from 'node:perf_hooks';
import { Container } from './frontend-cli/lib/tui/component.js';
import { ToolBlock } from './frontend-cli/lib/components/tool-block.js';
import { AssistantMessage } from './frontend-cli/lib/components/assistant-message.js';

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const kind of ['assistant', 'tool']) {
  for (const count of [20, 100, 400]) {
    const root = new Container();
    for (let i = 0; i < count; i++) {
      if (kind === 'assistant') {
        const block = new AssistantMessage({ color: false });
        block.append('A completed response with ordinary text and some content.\n'.repeat(8));
        block.finish();
        root.addChild(block);
      } else {
        const block = new ToolBlock({
          event: { tool_name: 'bash', arguments: { command: 'echo example' } },
          animate: false,
        });
        block.finish({
          status: 'completed', duration_ms: 42,
          result: JSON.stringify({ data: {
            stdout: 'A completed output line for benchmark.\n'.repeat(60),
            stderr: '', exit_code: 0,
          } }),
        });
        root.addChild(block);
      }
    }
    for (let i = 0; i < 5; i++) root.render(100);
    const wall = [], cpu = [];
    let lines = 0;
    for (let trial = 0; trial < 5; trial++) {
      const c0 = process.cpuUsage(), t0 = performance.now();
      for (let frame = 0; frame < 30; frame++) lines = root.render(100).length;
      wall.push((performance.now() - t0) / 30);
      const dc = process.cpuUsage(c0);
      cpu.push((dc.user + dc.system) / 1000 / 30);
    }
    console.log({ kind, count, lines, wallMs: median(wall), cpuMs: median(cpu) });
  }
}
```

V8 剖析在相同 fixture 外围使用 inspector 的 Profiler.start/stop；采样运行与上述计时运行分开。单次 profile 不足以形成稳定的产品占比结论。

### A.2 Python 流取消成本

通过 `python -B -` 运行，避免生成 pycache。这里关闭 token 的分支仅为测量对照，不是产品建议。

```python
import asyncio
import statistics
import time
from agent.domain.cancellation import CancellationToken
from agent.infrastructure.llm.cancellation import iterate_with_cancellation

async def source():
    for i in range(10_000):
        await asyncio.sleep(0)
        yield i

async def trial(enabled):
    token = CancellationToken() if enabled else None
    start = time.process_time()
    count = 0
    async for _ in iterate_with_cancellation(source(), token):
        count += 1
    assert count == 10_000
    return (time.process_time() - start) * 1000

async def main():
    for enabled in (False, True):
        samples = [await trial(enabled) for _ in range(5)]
        print(enabled, statistics.median(samples), 'CPU ms / 10,000 items')

asyncio.run(main())
```

## 附录 B：固定源码参考

以下均为本次固定提交的源码链接，结论限于本文实际讨论的机制，不将仓库 README 的性能描述当作本次测量结果。

- [C1：Codex 帧请求调度](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/tui/frame_requester.rs)
- [C2：Codex 帧率限制](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/tui/frame_rate_limiter.rs)
- [C3：Codex 流式控制器](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/streaming/controller.rs)
- [C4：Codex 稳定块渲染](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/streaming/render.rs)
- [C5：Codex 输出追赶策略](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/streaming/chunking.rs)
- [C6：Codex Markdown 缓存](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/history_cell/markdown_render_cache.rs)
- [C7：Codex transcript 布局缓存](https://github.com/openai/codex/blob/e6f4af1d92bbfadcc49217006c930f2a760f1cc8/codex-rs/tui/src/transcript_view/layout.rs)
- [P1：Pi TUI 调度](https://github.com/earendil-works/pi/blob/6f7551516b84278eb9da1c340c8e7bc66be1a6ba/packages/tui/src/tui.ts)
- [P2：Pi Markdown 组件缓存](https://github.com/earendil-works/pi/blob/6f7551516b84278eb9da1c340c8e7bc66be1a6ba/packages/tui/src/components/markdown.ts)
- [P3：Pi 帧内布局缓存](https://github.com/earendil-works/pi/blob/6f7551516b84278eb9da1c340c8e7bc66be1a6ba/packages/tui/src/layout.ts)
- [P4：Pi 字宽与 ASCII 快路径](https://github.com/earendil-works/pi/blob/6f7551516b84278eb9da1c340c8e7bc66be1a6ba/packages/tui/src/utils.ts)
- [P5：Pi 渲染分配基准](https://github.com/earendil-works/pi/blob/6f7551516b84278eb9da1c340c8e7bc66be1a6ba/packages/tui/test/render-churn-bench.ts)
- [P6：Pi 大历史基准](https://github.com/earendil-works/pi/blob/6f7551516b84278eb9da1c340c8e7bc66be1a6ba/packages/tui/test/alt-screen-large-transcript-bench.ts)
- [H1：Crush 消息更新合并](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/message/message.go)
- [H2：Crush 流式 Markdown](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/ui/chat/streaming_markdown.go)
- [H3：Crush 列表与版本缓存](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/ui/list/list.go)
- [H4：Crush 可见动画时钟](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/ui/model/chat.go)
- [H5：Crush 帧缓存](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/ui/model/framecache.go)
- [H6：Crush pubsub 背压行为](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/pubsub/broker.go)
- [H7：Crush 渲染基准](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/ui/model/renderbench_test.go)
- [H8：Crush resize 基准](https://github.com/charmbracelet/crush/blob/ae848542495815e127e248a313bbe79d38772d5c/internal/ui/chat/resize_bench_test.go)

Rind 内部契约同时参考仓库中的 `docs/architecture.md`、`docs/cli-rendering.md` 与 `test/README.md`。后续实现若改变这些契约，应在对应实现提交里同步更新，而非让本方案成为脱离代码的第二份规范。
