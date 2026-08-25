# CLI 渲染架构（pi 式 TTY 基建）

frontend-cli 的终端呈现采用"单组件树 + 全缓冲 diff 渲染"模型（借鉴 pi 的 tui 设计）。本文描述其结构与关键机制。

## 分层

```text
lib/tui/
├── tui.js            # createTui 引擎：diff 渲染、视口簿记、调度、光标定位
├── component.js      # Component / Container 基类
├── input-buffer.js   # 转义序列重组、bracketed paste 提取
└── cursor.js         # 光标标记插入（ANSI 感知）
lib/components/
├── text-block.js     # 静态文本块（宽度缓存折行）
├── dynamic-block.js  # 按宽度重建的动态块（用户输入、启动横幅）
├── assistant-message.js  # 流式 markdownish 消息组件
├── composer-area.js  # prompt chrome + 编辑器 + 菜单（含光标标记）
└── monitor-stack.js  # composer + 任务监视器的高度受限组合
```

## 核心契约

- 组件只实现 `render(width) -> string[]`；高度即返回行数，无布局协商。
- 应用状态变更后调用 `tui.requestRender()`；引擎合并请求并按 16ms 节流。
- 每帧流程：整树渲染为行数组 → 提取光标标记 → 行尾 SGR 重置 → 与上一帧逐行 diff → 仅重写变更区间（DEC 2026 同步输出包裹，单次 write）。

## 重绘策略

1. 首帧直接输出在既有终端内容之下，不清屏 —— 启动不会抹掉 shell 历史。
2. 已绘制状态下宽度/高度变化 → `\x1b[2J\x1b[H\x1b[3J` 清屏并清 scrollback 后**全量重放**。所有历史内容按新宽度重新折行 —— 这是 resize 后历史重排的实现机制。
3. 变更行越过视口顶（`firstChanged < previousViewportTop`）→ 全量重放。
4. 其余情况增量更新：纯追加走快速路径；缩短时清除尾部多余行。
5. 视口簿记（`previousViewportTop`、`hardwareCursorRow`、`maxLinesRendered`）保证内容超屏滚动后增量更新仍然落点正确。

调度契约：`requestRender(force)` 中 force 仅表示"跳过 16ms 节流、下一拍立即绘制"，绝不重置 diff 簿记；清屏与否只由 doRender 的几何检查决定。`replayAll()` 是唯一的例外入口：使全部组件缓存失效后复用 resize 路径（清屏+scrollback 全量重放），用于主题切换等外观级变更 —— 因此所有块在渲染期取色（AssistantMessage 存原始 markdown、log() 接受 thunk、ToolBlock 每帧重渲）。

## 内容模型

- **transcript**（`Container`）：启动横幅、用户回显、助手消息、工具行、错误、runtime stderr 全部是块组件，按序追加。
- **AssistantMessage**：turn 首个 delta 时创建，常驻至消息结束；内部持有完整原文与逐行渲染缓存，流式期间只有未完成行参与重排。
- **composer**：每帧由会话状态构建（prompt chrome、编辑器折行、菜单），通过 `CURSOR_MARKER` 把硬件光标钉在输入位置；本帧无任何焦点标记时硬件光标保持隐藏。turn/压缩运行期间 composer 是 steering 输入框，不注入标记 —— Working 状态下没有任何闪烁光标（问题菜单的自定义答案编辑除外）。
- **monitor**：任务监视器作为 composer 之后的区域，高度受限于剩余视口空间，保持 composer 可见。
- **tool blocks**：每个 `tool_call_id` 一个持久块（`components/tool-block.js`）。请求时以 `tool-display.js` 的定制标题出现（`$ cmd`、`edit <path>`、`grep /p/ in src` 等），运行中带本地秒级计时与心跳行，完成后**原地**变为结果渲染：bash 尾部输出、编辑 diff 计数与彩色 +/- 行、grep/glob 匹配数、delegate 摘要等。折叠上限按工具配置，溢出显示 `… (N more lines · ctrl+o to expand)`；全局 **ctrl+o** 切换所有块的展开态。渲染器为纯函数并接收权威宽度。

## 不变量

- 单一权威宽度：引擎的 `columns()` 是唯一来源，经 `render(width)` 下发；组件禁止读 `process.stdout.columns`。
- 所有 stdout 写入必须经过引擎；外部文本一律转为 transcript 块，不存在旁路直写。
- 渲染行的可见宽度超过终端宽度时由引擎防御性截断（`RIND_DEBUG_REDRAW=1` 可观察全量重绘原因）。

## 测试

- `test/helpers/virtual-terminal.js`：基于 `@xterm/headless` 的虚拟终端（devDependency，运行时保持零依赖），可断言屏幕实际显示、scrollback 与硬件光标位置。
- `test/tui-engine.test.js` 覆盖引擎策略；`test/tui-integration.test.js` 用真实 controller + 引擎验证流式、resize 重排、监视器限高；`test/tui-input-buffer.test.js` 覆盖输入重组。
