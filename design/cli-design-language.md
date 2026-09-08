# Rind CLI 设计语言

Rind 终端界面的统一视觉与信息规范。所有 CLI 改动应遵循本文件；它同时是评审清单。

来源：对 claude code、codex、pi、opencode、goose、crush、openclaw、Hermes 终端 UI 的系统研究，取其规则、去其装饰，收敛为 Rind 自己的词汇。

## 原则

1. **主次分明** — 每行只讲一件事；`bold` 只给主题词（You / Assistant / 面板标题），数值亮、标签暗、分隔符最暗。
2. **克制** — 没有数据就不渲染（上下文计量条在首次采样前不出现）；提示会自我抑制（菜单打开时隐藏快捷键行）；关闭的功能不出现在状态区（openclaw 规则）。
3. **稳定** — composer 行数恒定；计量条放在既有头部行内，不新增行（claude code 的 layout stability 规则）。
4. **百分比领先** — 先给比率，绝对值放暗色补充：`31% · 62.4k / 200k`（codex 规则）。
5. **诚实** — 不显示无法准确计算的东西（无定价数据就不显示成本）；压缩后计量条隐藏而不是显示误导性的 0（pi 的 `?/200k` 语义）。
6. **键盘完整** — 全部交互可键盘完成；提示统一 `key action · key action` 全暗格式。

## 字形词汇

| 字形 | 含义 | 出现位置 |
| --- | --- | --- |
| `▷` / `◁` | 用户 / 助手 | 消息块头部、输入行 |
| `◆` | 通知 | notice 块 |
| `✓` / `⊘` | 成功 / 失败 | 命令回执、工具结果 |
| `─` | 回合结束 | turn summary |
| `◌` / `◉` | 运行中 / 完成 | 工具块 |
| `▮▯` | 计量条 | 头部、/usage、/context、/status |
| `◐◓◑◒` | 活动指示 | 活动行 |
| `›` / `·` | 选中 / 未选中 | 各菜单 |
| `─ 标题 ───` | 面板标题 | sectionRule |
| `↑` / `↓` | 输入 / 输出 token | 用量展示 |

## 颜色与负载阈值

主题角色：`accent`（品牌/主操作）、`success`、`danger`、`warning`、`path`、`dim`。语义角色永远走 `paint`，不写裸 ANSI。

计量条按负载分级（goose/pi 阈值）：

- `< 60%` → accent
- `60–85%` → warning
- `≥ 85%` → danger

`loadMeter(ratio, cells = 10)` 是唯一计量条实现，禁止另造。

## 数字与格式

- `formatCount`：`< 1000` 原值；`≥ 1k` → `12.3k`；`≥ 100k` 取整 `121k`；`≥ 1M` → `1.2M`；尾零去掉。
- 比率展示：头部/面板用整数百分比 `31%`；命中率等精确值用 `93.0%`。
- 时长沿用 `formatDuration`（`1.20s` / `2m 05s`）。

## 信息出现在哪里

| 信息 | 位置 | 形式 |
| --- | --- | --- |
| 模型 / effort / 上下文负载 / 工作目录 | composer 头部行（常驻） | `model · effort · ▮▮▯ 31% · path` |
| 后台任务 | 头部行尾 | `[bg:n] [delegate:n]` |
| token 用量明细 | `/usage` 面板 | sectionRule + kvRow |
| 上下文构成 | `/context` 面板 | 窗口计量条 + 各部分份额行 |
| 回合成本 | turn summary 行 | `─ Worked for 4.20s · ↑12.3k ↓1.8k · 1 completed` |
| 会话操作结果 | notice / `✓` 回执 | `✓ Session forked — branch … · from …` |

数据流：`token_stats_updated` 事件喂头部计量条与累计；`context_built` 事件喂 `/context`；`turn_completed.usage` 喂回合小结与 `/usage` 的 last turn；切换/分支会话时从 worker 持久化的 `token_totals` / `latest_context_stats` 重新播种。

## Fork 语义

- fork = 携带完整历史的分支：复制消息、工具记录、压缩记录；`parent_session_id` 记录血缘；标题追加 `(fork)`。
- 分支重置回合状态与 token 累计（用量属于原会话），保留采样锚点（上下文内容一致，压力估计仍有效）。
- 播报语汇沿用 claude code：会话将被“forked”，不做“复制/克隆”表述。
- 运行中的回合禁止 fork（`TurnActive`）。

## Worker 边界

worker 只固化各 surface 共用的能力：用量累计、上下文摘要持久化、回合用量事件、`rind/session/fork`。渲染永远属于 surface。
